"""Offline AVM/TAN reprojection for the verified deep-sky image references.

Only NumPy/Pillow are required for generation. No online astrometry or AI pixels.
"""
import hashlib
import re
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image, ImageFilter


def read_avm(data):
    root = ET.fromstring(re.search(b"<x:xmpmeta.*?</x:xmpmeta>", data, re.S).group())
    avm = "{http://www.communicatingastronomy.org/avm/1.0/}"
    rdf = "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}"
    result = {}
    for key in ["ReferenceDimension", "ReferencePixel", "ReferenceValue", "Scale",
                "Rotation", "CoordinateFrame", "Equinox", "CoordsystemProjection", "Quality"]:
        for desc in root.findall(".//"+rdf+"Description"):
            tag = avm+"Spatial."+key
            if tag in desc.attrib:
                result[key] = desc.attrib[tag]
                break
            node = desc.find(tag)
            if node is not None:
                items = list(node.iter(rdf+"li"))
                result[key] = [float(x.text) for x in items] if items else "".join(node.itertext()).strip()
                break
        if key not in result:
            raise ValueError(f"Missing AVM {key}")
    result["Rotation"] = float(result["Rotation"])
    return result


def basis(ra, dec):
    a, d = np.radians([ra, dec])
    return np.array([np.cos(d)*np.cos(a), np.cos(d)*np.sin(a), np.sin(d)]), np.array([-np.sin(a), np.cos(a), 0]), np.array([-np.sin(d)*np.cos(a), -np.sin(d)*np.sin(a), np.cos(d)])


def pixel_matrix(wcs):
    # AVM Rotation is FITS CROTA2. Unlike a plain rotation of scaled axes,
    # this also handles the NOIRLab source's unequal X/Y pixel scales.
    if "CDMatrix" in wcs:
        return np.asarray(wcs["CDMatrix"])
    sx, sy = wcs["Scale"]
    c, s = np.cos(np.radians(wcs["Rotation"])), np.sin(np.radians(wcs["Rotation"]))
    return np.array([[sx*c, -sy*s], [sx*s, sy*c]])


def quad_wcs(sky_corners, dimensions, corner_tolerance=0.5):
    """Fit published image-edge corners to TAN/CD; not an original plate solve."""
    w, h = dimensions
    a, d = np.radians(sky_corners).T
    rays = np.column_stack([np.cos(d)*np.cos(a), np.cos(d)*np.sin(a), np.sin(d)])
    center = rays.mean(axis=0)
    center /= np.linalg.norm(center)
    ra, dec = float(np.degrees(np.arctan2(center[1], center[0])) % 360), float(np.degrees(np.arcsin(center[2])))
    center, east, north = basis(ra, dec)
    xy = np.column_stack([rays @ east, rays @ north])/(rays @ center)[:, None]*180/np.pi
    pixels = np.array([[-w/2, -h/2], [w/2, -h/2], [w/2, h/2], [-w/2, h/2]])
    fit = np.linalg.lstsq(np.column_stack([pixels, np.ones(4)]), xy, rcond=None)[0]
    cd = fit[:2].T
    offset = np.linalg.solve(cd, fit[2])
    error = np.linalg.norm((xy-fit[2]) @ np.linalg.inv(cd).T-pixels, axis=1)
    if corner_tolerance not in (0.5, 1):
        raise ValueError("Unsupported published-corner tolerance")
    if float(error.max()) >= corner_tolerance:
        raise ValueError("Published sky corners exceed the fixed source-pixel tolerance")
    return {"ReferenceDimension": [float(w), float(h)],
        "ReferencePixel": (np.array([(w+1)/2, (h+1)/2])-offset).tolist(),
        "ReferenceValue": [ra, dec], "CDMatrix": cd.tolist(),
        "CoordinateFrame": "ICRS", "Equinox": "J2000", "CoordsystemProjection": "TAN",
        "Quality": "Derived from published sky corners, not source AVM or an independent plate solution"}


def source_wcs(spec, data):
    if spec.get("registrationModel", "avm") == "avm":
        return read_avm(data)
    if spec["registrationModel"] == "stellarium-sky-corners":
        fitted = quad_wcs(spec["skyCorners"], spec["dimensions"], spec.get("cornerTolerancePixels", 0.5))
        for key in ("ReferenceDimension", "ReferencePixel", "ReferenceValue", "CDMatrix"):
            if not np.allclose(fitted[key], spec["wcs"][key], rtol=0, atol=1e-10):
                raise ValueError("Published corners and fixed TAN registration disagree")
        # Retain the pinned matrix despite harmless LAPACK rounding differences.
        return spec["wcs"]
    raise ValueError("Unknown image registration model")


def reference_pixels(rays, wcs):
    """AVM pixels: 1-based, lower-left; preserve the signed scales/rotation."""
    if wcs["CoordsystemProjection"] != "TAN" or wcs["CoordinateFrame"] != "ICRS" or wcs["Equinox"] != "J2000":
        raise ValueError("Only the verified ICRS/J2000 TAN sources are supported")
    center, east, north = basis(*wcs["ReferenceValue"])
    z = rays @ center
    tangent = np.stack([rays @ east / z, rays @ north / z], axis=-1)*180/np.pi
    return tangent @ np.linalg.inv(pixel_matrix(wcs)).T + np.array(wcs["ReferencePixel"])


def image_bounds(spec, obj):
    """Full source footprint in the target TAN plane; no inscribed ellipse."""
    wcs = spec["wcs"]
    w, h = wcs["ReferenceDimension"]
    pixels = np.array([[0.5, 0.5], [w+0.5, 0.5], [w+0.5, h+0.5], [0.5, h+0.5]]) if spec.get("registrationModel") == "stellarium-sky-corners" else np.array([[1, 1], [w, 1], [w, h], [1, h]])
    xy = np.radians((pixels-np.array(wcs["ReferencePixel"])) @ pixel_matrix(wcs).T)
    center, east, north = basis(*wcs["ReferenceValue"])
    rays = center+xy[:, :1]*east+xy[:, 1:]*north
    center, east, north = basis(obj["ra"], obj["dec"])
    xy = np.stack([rays @ east, rays @ north], axis=-1)/(rays @ center)[:, None]
    low, high = xy.min(axis=0), xy.max(axis=0)
    pad = (high-low)*0.03
    return [float(low[0]-pad[0]), float(low[1]-pad[1]), float(high[0]+pad[0]), float(high[1]+pad[1])]


def sample_image(source, pixels, wcs, edge_pixels=3):
    h, w, _ = source.shape
    # AVM explicitly rescales reference pixels and dimensions proportionally.
    px = pixels[..., 0]*w/wcs["ReferenceDimension"][0]-1
    py = h-pixels[..., 1]*h/wcs["ReferenceDimension"][1]
    valid = (px >= 0) & (py >= 0) & (px <= w-1) & (py <= h-1)
    edge = np.minimum.reduce([px, w-1-px, py, h-1-py])
    fade = np.clip(edge/edge_pixels, 0, 1)
    fade = fade*fade*(3-2*fade)*valid
    px, py = np.clip(px, 0, w-1), np.clip(py, 0, h-1)
    x0, y0 = np.floor(px).astype(int), np.floor(py).astype(int)
    x1, y1 = np.minimum(x0+1, w-1), np.minimum(y0+1, h-1)
    u, v = (px-x0)[..., None], (py-y0)[..., None]
    rgb = ((1-u)*source[y0, x0]+u*source[y0, x1])*(1-v)+((1-u)*source[y1, x0]+u*source[y1, x1])*v
    return rgb, fade, valid


def edge_background(rgb):
    """Smooth boundary-matched display background, not invented sky outside it."""
    h, w, _ = rgb.shape
    kernel = np.exp(-0.5*(np.arange(-24, 25)/8)**2)
    kernel /= kernel.sum()
    def smooth(profile):
        return np.stack([np.convolve(np.pad(profile[:, i], 24, mode="edge"), kernel, mode="valid") for i in range(3)], axis=-1)
    top, bottom, left, right = [smooth(p) for p in [rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]]]
    tl, tr = (top[0]+left[0])/2, (top[-1]+right[0])/2
    bl, br = (bottom[0]+left[-1])/2, (bottom[-1]+right[-1])/2
    # A harmonic interior avoids the overshoot/diagonal bands of a Coons patch.
    n = 64
    grid = np.full((n, n, 3), np.mean([tl, tr, bl, br], axis=0))
    for channel in range(3):
        for edge, profile in [(grid[0], top), (grid[-1], bottom), (grid[:, 0], left), (grid[:, -1], right)]:
            edge[:, channel] = np.interp(np.linspace(0, 1, n), np.linspace(0, 1, len(profile)), profile[:, channel])
    grid[0, 0], grid[0, -1], grid[-1, 0], grid[-1, -1] = tl, tr, bl, br
    for _ in range(1500):
        interior = (grid[:-2, 1:-1]+grid[2:, 1:-1]+grid[1:-1, :-2]+grid[1:-1, 2:])/4
        change = float(np.max(np.abs(interior-grid[1:-1, 1:-1])))
        grid[1:-1, 1:-1] = interior
        if change < 1e-7:
            break
    return np.stack([np.asarray(Image.fromarray(grid[..., c].astype(np.float32)).resize((w, h), Image.Resampling.BILINEAR)) for c in range(3)], axis=-1)


def square_filter(signal, size, maximum=False):
    """Float-preserving separable morphology; never quantize faint support."""
    radius = size//2
    operation = np.maximum if maximum else np.minimum
    result = signal.copy()
    for axis in (0, 1):
        padding = [(0, 0), (0, 0)]
        padding[axis] = (radius, radius)
        padded = np.pad(result, padding, mode="edge")
        views = [padded[i:i+signal.shape[0], :] if axis == 0 else padded[:, i:i+signal.shape[1]] for i in range(size)]
        result = views[0].copy()
        for view in views[1:]:
            operation(result, view, out=result)
    return result


def reconstruct_support(marker, signal):
    for iteration in range(2048):
        grown = square_filter(marker, 3, maximum=True)
        np.minimum(grown, signal, out=grown)
        if np.max(grown-marker) < 1e-7:
            return grown, iteration+1
        marker = grown
    raise ValueError("Diffuse support reconstruction did not converge")


def catalogue_support_seed(spec, obj, width, height):
    """Seed connected cloud support at the catalogue position in source pixels."""
    wcs = spec["wcs"]
    rw, rh = wcs["ReferenceDimension"]
    px, py = np.meshgrid((np.arange(width)+1)*rw/width, (height-np.arange(height))*rh/height)
    offset = np.stack([px-wcs["ReferencePixel"][0], py-wcs["ReferencePixel"][1]], axis=-1)
    tangent = np.radians(offset @ pixel_matrix(wcs).T)
    center, east, north = basis(*wcs["ReferenceValue"])
    target, _, _ = basis(obj["ra"], obj["dec"])
    projected = center @ target + tangent[..., 0]*(east @ target) + tangent[..., 1]*(north @ target)
    cosine = projected/np.sqrt(1+np.sum(tangent*tangent, axis=-1))
    return cosine >= np.cos(np.radians(obj["majorArcmin"]/120))


def diffuse_support(rgb, model, seed=None):
    """Colour-derived display support, not a spectral or calibrated starless map.

    Reconstruct broad cloud support under the original colour excess so narrow
    connected filaments survive. The final RGB is never filtered or inpainted.
    """
    r, g, b = rgb.transpose(2, 0, 1)
    red = np.maximum(r-(g+b)*0.5, 0)
    blue = np.maximum(b-r, 0)
    signal = (blue if model == "reflection" else np.maximum(red, blue) if model in ("mixed", "dark") else rgb.max(axis=-1) if model == "galaxy" else red).astype(np.float32)
    grown, iterations = reconstruct_support(square_filter(signal, 9), signal)
    # White stellar cores must not punch holes into genuine surrounding cloud.
    support = square_filter(square_filter(grown, 41, maximum=True), 41)
    kernel = np.exp(-0.5*(np.arange(-6, 7, dtype=float)/2)**2)
    kernel /= kernel.sum()
    for axis in (0, 1):
        support = np.apply_along_axis(lambda row: np.convolve(np.pad(row, 6, mode="edge"), kernel, mode="valid"), axis, support)
    border = np.concatenate([support[:12].ravel(), support[-12:].ravel(), support[:, :12].ravel(), support[:, -12:].ravel()])
    floor = max(0.002, float(np.percentile(border, 95)))
    ceiling = max(floor*4, floor+0.008)
    weight = np.clip((support-floor)/(ceiling-floor), 0, 1)
    weight = weight*weight*(3-2*weight)
    seed_iterations = None
    if seed is not None:
        # Catalogue size selects starting pixels only. Connected source cloud
        # may continue beyond it; no catalogue boundary clips the final RGB.
        if not np.any(weight[seed] > 0.01):
            raise ValueError("No diffuse signal at the catalogue support seed")
        weight, seed_iterations = reconstruct_support(np.where(seed, weight, 0), weight)
    return weight, {
        "model": "diffuse-colour-reconstruction", "openingPixels": 9,
        "reconstructionIterations": iterations, "holeClosingPixels": 41,
        "seedReconstructionIterations": seed_iterations,
        "supportBlurSigma": 2, "noiseFloor": floor, "fullSupport": ceiling,
        "supportedFraction": float(np.mean(weight > 0.01)),
        "fullSupportFraction": float(np.mean(weight > 0.99)),
    }


def image_components(source_dir, spec, obj, width, height=None):
    height = height or width
    if spec.get("backgroundModel", "border-percentile") not in ("border-percentile", "edge-harmonic", "none"):
        raise ValueError("Unknown reference background model")
    if spec.get("detailMode") not in (None, "source-rgb"):
        raise ValueError("Unknown reference detail mode")
    if spec.get("opacityModel") not in (None, "diffuse-colour-reconstruction", "continuum-reconstruction"):
        raise ValueError("Unknown reference opacity model")
    if spec.get("supportSeed") not in (None, "catalogue-centre"):
        raise ValueError("Unknown diffuse support seed")
    data = (source_dir/spec["file"]).read_bytes()
    if hashlib.sha256(data).hexdigest() != spec["sha256"]:
        raise ValueError(f"Source hash changed: {spec['file']}")
    wcs = source_wcs(spec, data)
    if wcs != spec["wcs"]:
        raise ValueError(f"Source WCS changed: {spec['file']}")
    image = Image.open(source_dir/spec["file"]).convert("RGB")
    if list(image.size) != spec["dimensions"]:
        raise ValueError("Source dimensions changed")
    working_max = spec.get("workingMaxSize", 1600)
    image.thumbnail((working_max, working_max), Image.Resampling.LANCZOS)
    # The native-detail sources use this low-frequency copy only to estimate
    # background. Filtering the final RGB would erase real filaments as well.
    opening = spec.get("starOpeningPixels", 5)
    if opening not in (5, 15, 31):
        raise ValueError("Unsupported star suppression scale")
    background_image = image.filter(ImageFilter.MedianFilter(7)).filter(ImageFilter.MinFilter(opening)).filter(ImageFilter.MaxFilter(opening))
    if opening > 5:
        background_image = background_image.filter(ImageFilter.GaussianBlur(8 if opening == 31 else 2))
    preserve_detail = spec.get("detailMode") == "source-rgb"
    rgb = np.asarray(image if preserve_detail else background_image, dtype=float)/255
    # Preserve the source RGB relationship. Linearize display data before sky
    # subtraction, rather than converting the whole red channel into Hα.
    rgb = np.where(rgb <= 0.04045, rgb/12.92, ((rgb+0.055)/1.055)**2.4)
    estimate = np.asarray(background_image, dtype=float)/255
    estimate = np.where(estimate <= 0.04045, estimate/12.92, ((estimate+0.055)/1.055)**2.4)
    border = np.concatenate([estimate[:12].reshape(-1, 3), estimate[-12:].reshape(-1, 3), estimate[:, :12].reshape(-1, 3), estimate[:, -12:].reshape(-1, 3)])
    background = np.percentile(border, 15, axis=0)
    if spec.get("backgroundModel") != "none":
        rgb = np.maximum(rgb-(edge_background(estimate) if spec.get("backgroundModel") == "edge-harmonic" else background), 0)
    support_stats = None
    dark = None
    if obj["model"] == "dark":
        # The wide optical source contains the dark silhouette itself. Estimate
        # its display contrast against nearby red emission, never stellar depth.
        # Filtering is used only for this estimate, not the final RGB texture.
        proxy = np.asarray(image.filter(ImageFilter.MedianFilter(7)), dtype=float)/255
        red = np.maximum(proxy[..., 0]-(proxy[..., 1]+proxy[..., 2])*0.5, 0).astype(np.float32)
        envelope = square_filter(square_filter(red, 81, maximum=True), 81)
        dark = np.clip((envelope-red)/np.maximum(envelope, 0.02), 0, 1)
        signal = np.clip((envelope-0.02)/0.10, 0, 1)
        # Keep the silhouette primarily in the source emission contrast.
        # A conservative background weight avoids isolated black cutouts in
        # the app's brighter approximate night sky and Milky Way panorama.
        dark *= signal*signal*(3-2*signal)*0.18
    if spec.get("opacityModel"):
        seed = None
        if spec.get("supportSeed") == "catalogue-centre":
            seed = catalogue_support_seed(spec, obj, image.width, image.height)
        support, support_stats = diffuse_support(rgb, obj["model"], seed)
        rgb = np.concatenate([rgb, support[..., None]], axis=-1)
    if dark is not None:
        rgb = np.concatenate([rgb, dark[..., None]], axis=-1)
    x0, y0, x1, y1 = obj["bounds"]
    x, y = np.meshgrid(np.linspace(x0, x1, width), np.linspace(y1, y0, height))
    center, east, north = basis(obj["ra"], obj["dec"])
    rays = center+x[..., None]*east+y[..., None]*north
    edge_pixels = spec.get("edgeFadePixels", 3)
    if edge_pixels not in (3, 12, 40):
        raise ValueError("Unsupported source-edge transition")
    sampled, fade, valid = sample_image(rgb, reference_pixels(rays, wcs), wcs, edge_pixels)
    sampled_dark = sampled[..., -1].copy() if dark is not None else None
    if support_stats:
        # Dark data has its own emission-envelope support, otherwise the actual
        # black silhouette would be erased by the RGB support it must darken.
        sampled_support = sampled[..., 3].copy()
        sampled = sampled[..., :3]
    else:
        sampled_support = 1
    r, g, b = sampled.transpose(2, 0, 1)
    if obj["model"] in ("galaxy", "reflection"):
        enhancement = np.zeros_like(r)
    else:
        # A conservative *additional* red structure proxy. Stock keeps all of
        # the baseline red; this cannot recover a calibrated Hα exposure.
        enhancement = np.clip(r-(g+b)*0.5, 0, 1)*0.6
    # The host framebuffer uses display RGB. Restore display colour ratios
    # after deriving a linear-light intensity, otherwise linear RGB displayed
    # directly becomes too saturated (especially the unmodified red nebula).
    intensity = sampled.max(axis=-1, keepdims=True)
    display = np.where(sampled <= 0.0031308, sampled*12.92, 1.055*sampled**(1/2.4)-0.055)
    display_signal = display/np.maximum(display.max(axis=-1, keepdims=True), 1e-9)*intensity
    if sampled_dark is None:
        fade *= sampled_support
        components = np.concatenate([display_signal, enhancement[..., None]], axis=-1)*fade[..., None]
    else:
        display_signal *= (fade*sampled_support)[..., None]
        components = np.concatenate([display_signal, (sampled_dark*fade)[..., None]], axis=-1)
    return components, {
        "catalogId": obj["catalogId"], "sourceSha256": spec["sha256"],
        "coveredPixels": int(np.count_nonzero(valid)), "totalPixels": width*height,
        "edgeFadePixels": edge_pixels, "usesEllipticalMask": False, "catalogueEnvelopeWeight": 0,
        "backgroundLinearRgb": background.tolist(),
        "workingDimensions": list(image.size),
        "backgroundModel": spec.get("backgroundModel", "border-percentile"),
        "starOpeningPixels": opening,
        "preservesSourceDetail": preserve_detail,
        "opacitySupport": support_stats,
        "outputDimensions": [width, height],
        "componentModel": "Baseline RGB plus additive red structure proxy; not measured spectral components",
        "darkContrast": {"model": "source-red-envelope-deficit", "closingPixels": 81, "maximumOpacity": 0.18, "scope": "Background contrast only, not optical depth or stellar distance"} if dark is not None else None,
    }

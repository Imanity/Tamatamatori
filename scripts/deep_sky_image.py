"""Offline AVM/TAN reprojection for the two current deep-sky image references.

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
    sx, sy = wcs["Scale"]
    c, s = np.cos(np.radians(wcs["Rotation"])), np.sin(np.radians(wcs["Rotation"]))
    return np.array([[sx*c, -sy*s], [sx*s, sy*c]])


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
    pixels = np.array([[1, 1], [w, 1], [w, h], [1, h]])
    xy = np.radians((pixels-np.array(wcs["ReferencePixel"])) @ pixel_matrix(wcs).T)
    center, east, north = basis(*wcs["ReferenceValue"])
    rays = center+xy[:, :1]*east+xy[:, 1:]*north
    center, east, north = basis(obj["ra"], obj["dec"])
    xy = np.stack([rays @ east, rays @ north], axis=-1)/(rays @ center)[:, None]
    low, high = xy.min(axis=0), xy.max(axis=0)
    pad = (high-low)*0.03
    return [float(low[0]-pad[0]), float(low[1]-pad[1]), float(high[0]+pad[0]), float(high[1]+pad[1])]


def sample_image(source, pixels, wcs):
    h, w, _ = source.shape
    # AVM explicitly rescales reference pixels and dimensions proportionally.
    px = pixels[..., 0]*w/wcs["ReferenceDimension"][0]-1
    py = h-pixels[..., 1]*h/wcs["ReferenceDimension"][1]
    valid = (px >= 0) & (py >= 0) & (px <= w-1) & (py <= h-1)
    edge = np.minimum.reduce([px, w-1-px, py, h-1-py])
    fade = np.clip(edge/3, 0, 1)
    fade = fade*fade*(3-2*fade)*valid
    px, py = np.clip(px, 0, w-1), np.clip(py, 0, h-1)
    x0, y0 = np.floor(px).astype(int), np.floor(py).astype(int)
    x1, y1 = np.minimum(x0+1, w-1), np.minimum(y0+1, h-1)
    u, v = (px-x0)[..., None], (py-y0)[..., None]
    rgb = ((1-u)*source[y0, x0]+u*source[y0, x1])*(1-v)+((1-u)*source[y1, x0]+u*source[y1, x1])*v
    return rgb, fade, valid


def image_components(source_dir, spec, obj, size):
    data = (source_dir/spec["file"]).read_bytes()
    if hashlib.sha256(data).hexdigest() != spec["sha256"]:
        raise ValueError(f"Source hash changed: {spec['file']}")
    wcs = read_avm(data)
    if wcs != spec["wcs"]:
        raise ValueError(f"Source WCS changed: {spec['file']}")
    image = Image.open(source_dir/spec["file"]).convert("RGB")
    if list(image.size) != spec["dimensions"]:
        raise ValueError("Source dimensions changed")
    image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
    # Local opening/median suppress foreground stars while retaining extended
    # dark lanes. Unresolved/large halos may remain; this is not star photometry.
    image = image.filter(ImageFilter.MedianFilter(7)).filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5))
    rgb = np.asarray(image, dtype=float)/255
    # Preserve the source RGB relationship. Linearize display data before sky
    # subtraction, rather than converting the whole red channel into Hα.
    rgb = np.where(rgb <= 0.04045, rgb/12.92, ((rgb+0.055)/1.055)**2.4)
    border = np.concatenate([rgb[:12].reshape(-1, 3), rgb[-12:].reshape(-1, 3), rgb[:, :12].reshape(-1, 3), rgb[:, -12:].reshape(-1, 3)])
    background = np.percentile(border, 15, axis=0)
    rgb = np.maximum(rgb-background, 0)
    x0, y0, x1, y1 = obj["bounds"]
    x, y = np.meshgrid(np.linspace(x0, x1, size), np.linspace(y1, y0, size))
    center, east, north = basis(obj["ra"], obj["dec"])
    rays = center+x[..., None]*east+y[..., None]*north
    sampled, fade, valid = sample_image(rgb, reference_pixels(rays, wcs), wcs)
    r, g, b = sampled.transpose(2, 0, 1)
    if obj["model"] == "galaxy":
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
    components = np.concatenate([display_signal, enhancement[..., None]], axis=-1)*fade[..., None]
    return components, {
        "catalogId": obj["catalogId"], "sourceSha256": spec["sha256"],
        "coveredPixels": int(np.count_nonzero(valid)), "totalPixels": size*size,
        "edgeFadePixels": 3, "usesEllipticalMask": False, "catalogueEnvelopeWeight": 0,
        "backgroundLinearRgb": background.tolist(),
        "workingDimensions": list(image.size),
        "componentModel": "Baseline RGB plus additive red structure proxy; not measured spectral components",
    }

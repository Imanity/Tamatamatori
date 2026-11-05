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


def reference_pixels(rays, wcs):
    """AVM pixels: 1-based, lower-left; preserve the signed scales/rotation."""
    if wcs["CoordsystemProjection"] != "TAN" or wcs["CoordinateFrame"] != "ICRS" or wcs["Equinox"] != "J2000":
        raise ValueError("Only the verified ICRS/J2000 TAN sources are supported")
    center, east, north = basis(*wcs["ReferenceValue"])
    z = rays @ center
    tangent = np.stack([rays @ east / z, rays @ north / z], axis=-1)*180/np.pi
    q = tangent/np.array(wcs["Scale"])
    c, s = np.cos(np.radians(wcs["Rotation"])), np.sin(np.radians(wcs["Rotation"]))
    return q @ np.array([[c, s], [-s, c]]) + np.array(wcs["ReferencePixel"])


def sample_image(source, pixels, wcs):
    h, w, _ = source.shape
    # AVM explicitly rescales reference pixels and dimensions proportionally.
    px = pixels[..., 0]*w/wcs["ReferenceDimension"][0]-1
    py = h-pixels[..., 1]*h/wcs["ReferenceDimension"][1]
    valid = (px >= 0) & (py >= 0) & (px <= w-1) & (py <= h-1)
    edge = np.minimum.reduce([px/(w-1), 1-px/(w-1), py/(h-1), 1-py/(h-1)])
    fade = np.clip(edge/0.18, 0, 1)
    fade = fade*fade*(3-2*fade)*valid
    # Only the inscribed ellipse is used for structure: rectangular publication
    # crop boundaries must not turn into visible objects in the sky.
    radius = np.hypot(2*px/(w-1)-1, 2*py/(h-1)-1)
    radial = np.clip((1-radius)/0.38, 0, 1)
    fade *= radial*radial*(3-2*radial)
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
    image = image.filter(ImageFilter.MedianFilter(5)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    rgb = np.asarray(image, dtype=float)/255
    rgb = np.clip((rgb-0.018)/0.982, 0, 1)**1.15
    x0, y0, x1, y1 = obj["bounds"]
    x, y = np.meshgrid(np.linspace(x0, x1, size), np.linspace(y1, y0, size))
    center, east, north = basis(obj["ra"], obj["dec"])
    rays = center+x[..., None]*east+y[..., None]*north
    sampled, fade, valid = sample_image(rgb, reference_pixels(rays, wcs), wcs)
    r, g, b = sampled.transpose(2, 0, 1)
    if obj["model"] == "galaxy":
        continuum = np.clip((0.2126*r+0.7152*g+0.0722*b)*1.35, 0, 1)
        components = np.stack([continuum, np.zeros_like(r), np.zeros_like(r)], axis=-1)
    else:
        # Display-colour proxies only. The released R channel mixes R/Hα and
        # the purple channel includes U: no spectral inversion is claimed.
        continuum = np.minimum.reduce([r, g, b])*0.28
        hydrogen = np.clip(r-0.20*np.minimum(g, b), 0, 1)*0.95
        other = (g+b)*0.44
        components = np.stack([continuum, hydrogen, other], axis=-1)
    return components, fade, {
        "catalogId": obj["catalogId"], "sourceSha256": spec["sha256"],
        "coveredPixels": int(np.count_nonzero(valid)), "totalPixels": size*size,
        "featherFraction": 0.18, "ellipticalFeatherWidth": 0.38,
        "workingDimensions": list(image.size),
        "componentModel": "Display-colour structure proxies, not measured spectral components",
    }

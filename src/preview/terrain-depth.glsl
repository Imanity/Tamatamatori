// Full 0..1 logarithmic depth; 1 is reserved for celestial background.
uniform highp float u_photo_enabled;
in highp float v_photo_depth;
float photoFragmentDepth(float distance) {
    return clamp(log2(1.0 + max(0.0, distance)) / log2(10000001.0), 0.0, 0.9999999);
}

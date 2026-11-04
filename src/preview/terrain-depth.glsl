// Full 0..1 logarithmic depth; 1 is reserved for celestial background.
uniform highp float u_photo_enabled;
in highp float v_photo_depth;
in highp vec2 v_photo_fog;
float photoFragmentDepth(float distance) {
    return clamp(log2(1.0 + max(0.0, distance)) / log2(10000001.0), 0.0, 0.9999999);
}
float photoFogDepth(float planarDepth) {
    if (u_photo_enabled < 0.5) return planarDepth;
    // Interpolate homogeneous fog coordinates, then divide per fragment.
    // Dividing at a vertex behind the eye contaminates a clipped triangle.
    if (v_photo_fog.y <= 0.0) return 0.0;
    return clamp(v_photo_fog.x / v_photo_fog.y * 0.5 + 0.5, 0.0, 1.0);
}

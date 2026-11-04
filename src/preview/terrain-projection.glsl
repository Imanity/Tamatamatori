// Tamatamatori local ENU bridge. Heights share the DEM's conditional datum.
uniform highp float u_photo_enabled;
uniform vec4 u_photo_tile;
uniform vec3 u_photo_base;
uniform mat3 u_photo_basis;
uniform mat4 u_photo_camera;
out highp float v_photo_depth;

// Some GPU transcendental implementations have absolute error near zero.
// A local polynomial avoids magnifying that error by the Earth radius.
float photoSin(float x) {
    float s = x * x;
    return abs(x) < 0.1 ? x * (1.0 - s/6.0 + s*s/120.0 - s*s*s/5040.0) : sin(x);
}

vec3 photoRay(vec2 p, float h) {
    float t = -(p.y - 4096.0) * u_photo_tile.w;
    float halfT = t * 0.5;
    float sh = abs(halfT) < 0.1 ? halfT * (1.0 + halfT * halfT * (1.0/6.0 + halfT * halfT/120.0)) : sinh(halfT);
    float q = u_photo_tile.y * sh / (sqrt(1.0 + sh * sh) + u_photo_tile.x * sh);
    float dp = abs(q) < 0.05 ? 2.0 * q * (1.0 - q*q/3.0 + q*q*q*q/5.0) : 2.0 * atan(q);
    float dl = (p.x - 4096.0) * u_photo_tile.w;
    float sd = photoSin(dp);
    float cp1 = -2.0 * photoSin(dp * 0.5) * photoSin(dp * 0.5);
    float cl1 = -2.0 * photoSin(dl * 0.5) * photoSin(dl * 0.5);
    float ds = u_photo_tile.x * cp1 + u_photo_tile.y * sd;
    float c = u_photo_tile.y * (1.0 + cp1) - u_photo_tile.x * sd;
    const float e2 = 0.0066943799901413165;
    float v = e2 * ds * (2.0 * u_photo_tile.x + ds) / (1.0 - e2 * u_photo_tile.x * u_photo_tile.x);
    float root = sqrt(1.0 - v);
    float dn = u_photo_tile.z * v / (root * (1.0 + root));
    float n = u_photo_tile.z + dn;
    float r = n + h;
    float correction = e2 * (dn * u_photo_tile.x + n * ds);
    vec3 local = vec3(r * c * photoSin(dl),
        r * sd - correction * u_photo_tile.y - r * c * u_photo_tile.x * cl1,
        h + dn - correction * u_photo_tile.x + r * (cp1 + c * u_photo_tile.y * cl1));
    return u_photo_base + u_photo_basis * local;
}
vec4 photoProject(vec2 p, float h) {
    vec4 clip = u_photo_camera * vec4(photoRay(p, h), 1.0);
    v_photo_depth = clip.w;
    return clip;
}

export function weatherResponse(start = Date.UTC(2026, 10, 4), length = 168) {
  const values = {
    cloud_cover: [60, "%"], cloud_cover_low: [40, "%"], cloud_cover_mid: [25, "%"], cloud_cover_high: [20, "%"],
    precipitation: [1, "mm"], precipitation_probability: [40, "%"], rain: [0.8, "mm"], showers: [0.2, "mm"],
    snowfall: [0, "cm"], visibility: [10000, "m"], wind_speed_10m: [3, "m/s"], wind_direction_10m: [350, "°"],
  };
  return { latitude: 35.4, longitude: 138.875, utc_offset_seconds: 0,
    hourly_units: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value[1]])),
    hourly: { time: Array.from({ length }, (_, index) => start / 1000 + index * 3600),
      ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Array(length).fill(value[0])])) } };
}

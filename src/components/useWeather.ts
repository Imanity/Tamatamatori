import { useEffect, useMemo, useState } from "react";
import type { ShootingPlan } from "../domain/plan";
import { sampleWeather, WEATHER_TTL, weatherLocationKey } from "../domain/weather";
import type { WeatherForecast } from "../domain/weather";
import { loadWeather, loadWeatherSource } from "../preview/weather";
import { bestMatchSource } from "../domain/weather-source";
import type { BestMatchSeries } from "../domain/weather-source";

interface WeatherState {
  key: string;
  phase: "off" | "loading" | "ready" | "error";
  forecast?: WeatherForecast;
  message?: string;
}

export function useWeather(plan: ShootingPlan) {
  const enabled = !!plan.weather, model = plan.weatherModel ?? "best_match";
  const key = `${weatherLocationKey(plan)}/${model}`;
  const [state, setState] = useState<WeatherState>({ key, phase: "off" });
  const [attempt, setAttempt] = useState(0);
  // Which model "自动匹配" uses, found by comparing hourly cloud cover.
  const [source, setSource] = useState<{ key: string; phase: "loading" | "ready" | "error"; series?: BestMatchSeries }>({ key: "", phase: "loading" });
  const sourceWanted = enabled && model === "best_match";
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    const update = () => setClock(Date.now());
    const timer = setInterval(update, 60_000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let disposed = false;
    setState(previous => ({ key, phase: "loading", forecast: previous.key === key ? previous.forecast : undefined }));
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const timer = setTimeout(() => {
      void loadWeather(plan, controller.signal, Date.now(), model)
        .then(forecast => {
          if (!disposed) setState({ key, phase: "ready", forecast });
        })
        .catch((cause: unknown) => {
          if (!disposed) setState({ key, phase: "error", message:
            cause instanceof Error && cause.name !== "AbortError" ? cause.message : "天气数据读取超时" });
        })
        .finally(() => clearTimeout(timeout));
    }, 250);
    return () => { disposed = true; clearTimeout(timer); clearTimeout(timeout); controller.abort(); };
  }, [enabled, key, attempt]);
  useEffect(() => {
    if (!sourceWanted) return;
    const controller = new AbortController();
    let disposed = false;
    setSource((previous) => previous.key === key && previous.series ? previous : { key, phase: "loading" });
    const timer = setTimeout(() => {
      void loadWeatherSource(plan, controller.signal, Date.now())
        .then((series) => { if (!disposed) setSource({ key, phase: "ready", series }); })
        .catch(() => { if (!disposed) setSource({ key, phase: "error" }); });
    }, 300);
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [sourceWanted, key, attempt]);
  const sourceSeries = sourceWanted && source.key === key ? source.series : undefined;
  const autoSource = useMemo(() => {
    if (!sourceWanted) return null;
    if (!sourceSeries) return { phase: source.key === key && source.phase === "error" ? "error" as const : "loading" as const, label: null };
    const found = bestMatchSource(sourceSeries, plan.instant);
    return { phase: "ready" as const, label: found?.label ?? null };
  }, [sourceWanted, sourceSeries, source.key, source.phase, key, plan.instant]);
  const now = Math.max(clock, Date.now());
  const expired = !!state.forecast && (now < state.forecast.fetchedAt || now - state.forecast.fetchedAt >= WEATHER_TTL);
  useEffect(() => {
    if (enabled && expired && state.phase === "ready") setAttempt(value => value + 1);
  }, [enabled, expired, state.phase]);
  const current = !enabled ? { key, phase: "off" as const }
    : state.key !== key || state.phase === "off" ? { key, phase: "loading" as const } : state;
  const forecast = current.forecast;
  const outside = !!forecast && (Date.parse(plan.instant) < forecast.hours[0].time || Date.parse(plan.instant) > forecast.hours.at(-1)!.time);
  const sample = useMemo(() => current.phase === "ready" && !expired && forecast ? sampleWeather(forecast, plan.instant) : null,
    [current.phase, expired, forecast, plan.instant]);
  const phase = (current.phase === "ready" || current.phase === "loading") && expired ? "stale"
    : current.phase === "ready" ? outside ? "outside" : sample ? "ready" : "missing" : current.phase;
  return { phase, forecast, sample, message: current.message, autoSource,
    retry: () => { setClock(Date.now()); setAttempt(value => value + 1); } };
}
export type WeatherFeed = ReturnType<typeof useWeather>;

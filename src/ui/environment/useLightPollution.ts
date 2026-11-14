import { useEffect, useState } from "react";
import type { ShootingPlan } from "../../domain/core/plan";
import type { PollutionSample } from "../../domain/environment/light-pollution";

interface PollutionState {
  key: string;
  phase: "off" | "loading" | "ready" | "unavailable" | "error";
  sample?: PollutionSample;
  /** The atlas year, from the index read with the first sample. */
  year?: number;
  message?: string;
}

export function useLightPollution(plan: ShootingPlan) {
  const enabled = !!plan.lightPollution;
  const key = `${plan.longitude}/${plan.latitude}`;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PollutionState>({ key, phase: "off" });
  useEffect(() => {
    if (!enabled) {
      setState({ key, phase: "off" });
      return;
    }
    const controller = new AbortController();
    let disposed = false;
    setState({ key, phase: "loading" });
    const timer = setTimeout(() => controller.abort(), 15000);
    const debounce = setTimeout(() => {
      // The index is read with the loader: outside the atlas, or a sample with its year.
      void import("../../io/light-pollution")
        .then(async (module) => {
          if (!module.lightPollutionCells(plan)) return { outside: true as const };
          return { sample: await module.sampleLightPollution(plan, controller.signal), year: module.lightPollutionAtlas.year };
        })
        .then((read) => {
          if (disposed) return;
          if ("outside" in read) setState({ key, phase: "unavailable", message: "当前机位超出光污染图集覆盖范围" });
          else if (read.sample) setState({ key, phase: "ready", sample: read.sample, year: read.year });
          else setState({ key, phase: "unavailable", message: "当前机位缺少有效光污染像元" });
        })
        .catch((cause: unknown) => {
          if (!disposed)
            setState({
              key,
              phase: "error",
              message:
                cause instanceof Error && cause.name !== "AbortError"
                  ? cause.message
                  : "光污染数据读取超时",
            });
        })
        .finally(() => clearTimeout(timer));
    }, 120);
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(debounce);
      controller.abort();
    };
  }, [enabled, key, plan.longitude, plan.latitude, attempt]);
  const current: PollutionState = !enabled
    ? { key, phase: "off" }
    : state.key !== key || state.phase === "off"
      ? { key, phase: "loading" }
      : state;
  return { ...current, retry: () => setAttempt((value) => value + 1) };
}

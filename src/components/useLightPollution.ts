import { useEffect, useState } from "react";
import type { ShootingPlan } from "../domain/plan";
import { lightPollutionCells } from "../domain/light-pollution";
import type { PollutionSample } from "../domain/light-pollution";

interface PollutionState {
  key: string;
  phase: "off" | "loading" | "ready" | "unavailable" | "error";
  sample?: PollutionSample;
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
    if (!lightPollutionCells(plan)) {
      setState({
        key,
        phase: "unavailable",
        message: "当前机位超出光污染图集覆盖范围",
      });
      return;
    }
    setState({ key, phase: "loading" });
    const timer = setTimeout(() => controller.abort(), 15000);
    const debounce = setTimeout(() => {
      void import("../preview/light-pollution")
        .then((module) => module.sampleLightPollution(plan, controller.signal))
        .then((sample) => {
          if (!disposed)
            setState(
              sample
                ? { key, phase: "ready", sample }
                : {
                    key,
                    phase: "unavailable",
                    message: "当前机位缺少有效光污染像元",
                  },
            );
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

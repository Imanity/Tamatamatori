import type { ReactNode } from "react";

export type InfoGroupId =
  | "buildings"
  | "global"
  | "sun"
  | "moon"
  | "stars"
  | "milkyWay"
  | "deepSky"
  | "stations"
  | "meteors";
/**
 * A layer switch expands and reveals its group (`open`) or collapses it;
 * `sync` sets every layer group to its switch after a whole plan was applied.
 */
export type InfoNavigation =
  | { id: InfoGroupId; open: boolean; request: number }
  | { sync: true; request: number };

export function InfoGroup({
  id,
  title,
  open,
  toggle,
  children,
}: {
  id: InfoGroupId;
  title: string;
  open: boolean;
  toggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="info-group" data-info-group={id}>
      <h2>
        <button
          id={`info-${id}`}
          aria-expanded={open}
          aria-controls={`info-${id}-body`}
          onClick={toggle}
        >
          <span>{title}</span>
          <span aria-hidden="true">{open ? "−" : "+"}</span>
        </button>
      </h2>
      <div id={`info-${id}-body`} hidden={!open} aria-labelledby={`info-${id}`}>
        {children}
      </div>
    </section>
  );
}

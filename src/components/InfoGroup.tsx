import type { ReactNode } from "react";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";

export type InfoGroupId =
  | "buildings"
  | "global"
  | "sun"
  | "moon"
  | "stars"
  | "milkyWay"
  | "deepSky"
  | "stations"
  | "meteors"
  | "comets";
/**
 * A layer switch expands and reveals its group (`open`) or collapses it;
 * `sync` sets every layer group to its switch after a whole plan was applied.
 */
export type InfoNavigation =
  | { id: InfoGroupId; open: boolean; request: number }
  | { sync: true; request: number };

/**
 * A collapsible group of the information panel. A layer group carries its
 * layer switch in the heading row, beside (not inside) the expand button.
 */
export function InfoGroup({
  id,
  title,
  icon,
  open,
  toggle,
  layer,
  children,
}: {
  id: InfoGroupId;
  title: string;
  icon?: IconName;
  open: boolean;
  toggle: () => void;
  layer?: { name: string; checked: boolean; onToggle: () => void };
  children: ReactNode;
}) {
  return (
    <section className="info-group" data-info-group={id}>
      <div className="info-group-header">
        <h2>
          <button
            id={`info-${id}`}
            aria-expanded={open}
            aria-controls={`info-${id}-body`}
            onClick={toggle}
          >
            {icon && <Icon name={icon} size={16} />}
            <span className="info-group-title">{title}</span>
            <span aria-hidden="true" className="info-group-sign">{open ? "−" : "+"}</span>
          </button>
        </h2>
        {layer && (
          <input
            type="checkbox"
            role="switch"
            className="info-group-switch"
            aria-label={`显示${layer.name}`}
            checked={layer.checked}
            onChange={layer.onToggle}
          />
        )}
      </div>
      <div id={`info-${id}-body`} hidden={!open} aria-labelledby={`info-${id}`}>
        {children}
      </div>
    </section>
  );
}

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Icon } from "./Icon";
import {
  allTimeZones,
  commonTimeZones,
  searchTimeZones,
  zoneCity,
  zoneGenericName,
  zoneOffset,
  zoneOffsetMinutes,
} from "../domain/time-zones";
import { validTimeZone } from "../domain/shot";

const RESULT_LIMIT = 80;
// "local" is the follow-the-position option; every other option is a fixed zone.
const LOCAL = "local";
type Row = { kind: "group"; label: string } | { kind: "divider" } | { kind: "option"; zone: string; index: number; detail: string };

function browserZone() {
  try {
    return validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

/**
 * Display time zone picker. Any IANA zone can be chosen; offsets are those in
 * force at the shooting instant, so daylight saving is shown correctly.
 * The list opens inline below the row so the scrolling panel never clips it.
 */
export function TimeZoneField({
  zone,
  instant,
  onChange,
  follow = false,
  localZone = null,
  onFollow,
}: {
  zone: string;
  instant: string;
  onChange: (zone: string) => void;
  /** The zone follows the camera position ("当地时区"). */
  follow?: boolean;
  /** The position's zone, or null when it cannot be determined. */
  localZone?: string | null;
  onFollow?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const id = useId();
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLUListElement>(null);
  const detail = (item: string) => {
    const generic = zoneGenericName(item, instant);
    return [item, generic, zoneOffset(item, instant)].filter(Boolean).join(" · ");
  };
  const { rows, options, hidden } = useMemo(() => {
    const rows: Row[] = [], options: string[] = [];
    let hidden = 0;
    if (!open) return { rows, options, hidden };
    const push = (item: string) => {
      rows.push({ kind: "option", zone: item, index: options.length, detail: detail(item) });
      options.push(item);
    };
    const pushLocal = () => {
      if (!onFollow || !localZone) return;
      rows.push({ kind: "option", zone: LOCAL, index: options.length, detail: `随机位 · ${detail(localZone)}` });
      options.push(LOCAL);
    };
    if (!query.trim()) {
      rows.push({ kind: "group", label: "常用" });
      pushLocal();
      [...new Set([zone, browserZone(), ...commonTimeZones])].forEach((item) => item && push(item));
      // All zones follow, ordered by the offset at the shooting instant.
      rows.push({ kind: "divider" });
      [...allTimeZones()]
        .sort((a, b) => zoneOffsetMinutes(a, instant) - zoneOffsetMinutes(b, instant) || a.localeCompare(b))
        .forEach(push);
    } else {
      if (/当地|本地|机位|local/i.test(query)) pushLocal();
      const found = searchTimeZones(query, instant);
      found.slice(0, RESULT_LIMIT).forEach(push);
      hidden = Math.max(0, found.length - RESULT_LIMIT);
    }
    return { rows, options, hidden };
  }, [open, query, zone, instant, localZone, onFollow]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);
  const show = () => {
    setQuery("");
    setActive(0);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const choose = (item: string) => {
    if (item === LOCAL) onFollow?.();
    else if (validTimeZone(item)) onChange(item);
    close();
  };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[event.key];
    if (step) {
      event.preventDefault();
      setActive((current) => Math.max(0, Math.min(options.length - 1, current + step)));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : options.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (options[active]) choose(options[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") setOpen(false);
  };
  const listId = `${id}-zones`;
  return (
    <div className="field timezone-field" ref={root}>
      <span className="field-label" id={`${id}-label`}>显示时区</span>
      <button
        ref={trigger}
        type="button"
        className="timezone-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label ${id}-value`}
        title={`${follow ? "当地时区，随机位变化 · " : ""}${detail(zone)}`}
        onClick={() => (open ? setOpen(false) : show())}
      >
        <span id={`${id}-value`}>
          {follow && <small className="timezone-local">当地</small>}
          <strong>{zoneCity(zone)}</strong>
          <small>{zoneOffset(zone, instant)}</small>
        </span>
        <Icon name="chevron" size={13} />
      </button>
      {open && (
        <div className="timezone-picker">
          <input
            role="combobox"
            aria-label="搜索时区"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={options.length ? `${id}-option-${active}` : undefined}
            placeholder="城市、时区或 UTC+8"
            value={query}
            autoFocus
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={keys}
          />
          <ul className="timezone-list" role="listbox" id={listId} aria-label="时区" ref={list}>
            {rows.map((row, index) =>
              row.kind === "group" ? (
                <li key={`group-${index}`} role="presentation" className="timezone-group">
                  {row.label}
                </li>
              ) : row.kind === "divider" ? (
                <li key={`divider-${index}`} role="presentation" className="timezone-divider" />
              ) : (
                <li
                  key={`${row.zone}-${row.index}`}
                  id={`${id}-option-${row.index}`}
                  data-index={row.index}
                  data-zone={row.zone}
                  role="option"
                  aria-selected={row.zone === LOCAL ? follow : !follow && row.zone === zone}
                  className={row.index === active ? "is-active" : undefined}
                  onPointerDown={(event) => event.preventDefault()}
                  onPointerMove={() => setActive(row.index)}
                  onClick={() => choose(row.zone)}
                >
                  <strong>{row.zone === LOCAL ? "当地时区" : zoneCity(row.zone)}</strong>
                  <small>{row.detail}</small>
                </li>
              ),
            )}
          </ul>
          {!options.length && <p className="timezone-note">没有匹配的时区，可输入城市英文名、IANA 时区或 UTC 偏移。</p>}
          {hidden > 0 && <p className="timezone-note">另有 {hidden} 个匹配，继续输入以缩小范围。</p>}
        </div>
      )}
    </div>
  );
}

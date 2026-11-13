import type { ShootingPlan } from "../../domain/core/plan.ts";
import type { DeepSkyTarget } from "../../domain/sky/deep-sky.ts";
import { deepSkyTextureRequests, deepSkyCatalog, deepSkyImageEntry } from "../../domain/sky/deep-sky.ts";
import { loadDeepSkyImage } from "./deep-sky-texture.ts";
import { SkyTexture } from "./sky-texture.ts";
import type { SkyTextureState } from "./sky-texture.ts";

/** Current image resources, with the Horsehead/Flame field shared once. */
export class DeepSkyTextures {
  private slots = new Map<string, { resource: SkyTexture; maxSize: number }>();
  private changed: () => void;
  private load: typeof loadDeepSkyImage;
  constructor(changed: () => void, load = loadDeepSkyImage) {
    this.changed = changed;
    this.load = load;
  }
  get states(): Record<string, SkyTextureState> {
    return Object.fromEntries(deepSkyCatalog.flatMap(entry => {
      const slot = this.slots.get(deepSkyImageEntry(entry).id);
      return slot ? [[entry.id, slot.resource.state]] : [];
    }));
  }
  get state(): SkyTextureState {
    const states = [...this.slots.values()].map(slot => slot.resource.state);
    const error = states.find(state => state.phase === "error");
    if (error) return error;
    return { phase: states.some(state => state.phase === "loading") ? "loading" : "ready" };
  }
  texture(id: string) {
    const entry = deepSkyCatalog.find(object => object.id === id);
    return this.slots.get(entry ? deepSkyImageEntry(entry).id : id)?.resource.texture;
  }
  update(plan: ShootingPlan, objects: DeepSkyTarget[], gl: WebGL2RenderingContext, width: number, height: number) {
    const requests = deepSkyTextureRequests(plan, objects, width, height, Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 2048);
    let changed = false;
    for (const [id, slot] of this.slots) {
      if (!requests.some(request => request.object.id === id && request.maxSize === slot.maxSize)) {
        slot.resource.dispose(gl);
        this.slots.delete(id);
        changed = true;
      }
    }
    for (const { object, maxSize } of requests) {
      if (!this.slots.has(object.id)) {
        const resource = new SkyTexture(`${object.name}结构`, "深空天体", false,
          (signal, deviceMax) => this.load(signal, Math.min(deviceMax, maxSize), object.entry), this.changed);
        this.slots.set(object.id, { resource, maxSize });
        changed = true;
      }
      this.slots.get(object.id)!.resource.setEnabled(true, gl);
    }
    if (changed) this.changed();
  }
  upload(gl: WebGL2RenderingContext) {
    let uploaded = false;
    for (const { resource } of this.slots.values()) uploaded = resource.upload(gl) || uploaded;
    return uploaded;
  }
  dispose(gl?: WebGL2RenderingContext) {
    for (const { resource } of this.slots.values()) resource.dispose(gl);
    this.slots.clear();
  }
}

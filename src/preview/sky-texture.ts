export type SkyTextureState = {
  phase: "off" | "loading" | "ready" | "error";
  message?: string;
};
type Loader = (signal: AbortSignal, maxSize: number) => Promise<ImageBitmap>;
/** Resource lifecycle shared by the two currently used sky atlases. GL state is owned by the caller. */
export class SkyTexture {
  texture?: WebGLTexture;
  state: SkyTextureState = { phase: "loading" };
  private bitmap?: ImageBitmap;
  private request?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private enabled = false;
  private load: Loader;
  private changed: () => void;
  private name: string;
  private layerName: string;
  private repeat: boolean;
  constructor(
    name: string,
    layerName: string,
    repeat: boolean,
    load: Loader,
    changed: () => void,
  ) {
    this.name = name;
    this.layerName = layerName;
    this.repeat = repeat;
    this.load = load;
    this.changed = changed;
  }
  private cancel() {
    this.request?.abort();
    this.request = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  setEnabled(enabled: boolean, gl?: WebGL2RenderingContext) {
    this.enabled = enabled;
    if (!enabled) {
      this.cancel();
      this.bitmap?.close();
      this.bitmap = undefined;
      this.state = { phase: this.texture ? "ready" : "loading" };
      return;
    }
    if (
      !gl ||
      this.texture ||
      this.bitmap ||
      this.request ||
      this.state.phase === "error"
    )
      return;
    const request = new AbortController();
    this.request = request;
    this.timer = setTimeout(() => {
      if (this.request !== request) return;
      this.cancel();
      this.error("加载超时");
    }, 12000);
    const maxSize = Math.max(
      1,
      Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 2048,
    );
    void this.load(request.signal, maxSize)
      .then((image) => {
        if (
          this.request !== request ||
          request.signal.aborted ||
          !this.enabled
        ) {
          image.close();
          return;
        }
        this.request = undefined;
        clearTimeout(this.timer);
        this.bitmap = image;
        this.changed();
      })
      .catch(() => {
        if (this.request !== request || request.signal.aborted) return;
        this.request = undefined;
        clearTimeout(this.timer);
        this.error("加载失败");
      });
  }
  private error(reason: string) {
    this.state = {
      phase: "error",
      message: `${this.name}${reason}，请关闭再开启${this.layerName}重试。`,
    };
    this.changed();
  }
  upload(gl: WebGL2RenderingContext) {
    if (!this.bitmap) return false;
    try {
      this.texture = gl.createTexture() ?? undefined;
      if (!this.texture) throw new Error("texture allocation");
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.bitmap,
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        gl.LINEAR_MIPMAP_LINEAR,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_S,
        this.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.generateMipmap(gl.TEXTURE_2D);
      if (!this.repeat)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 4);
      this.state = { phase: "ready" };
    } catch {
      gl.deleteTexture(this.texture ?? null);
      this.texture = undefined;
      this.error("无法上传");
    } finally {
      this.bitmap.close();
      this.bitmap = undefined;
    }
    this.changed();
    return this.state.phase === "ready";
  }
  dispose(gl?: WebGL2RenderingContext) {
    this.enabled = false;
    this.cancel();
    this.bitmap?.close();
    this.bitmap = undefined;
    gl?.deleteTexture(this.texture ?? null);
    this.texture = undefined;
  }
}

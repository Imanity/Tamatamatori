/** A build target, never a probe of localhost from the public site. */
export const LOCAL_MODE = import.meta.env.MODE === "desktop";

export async function localJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `本地服务返回 ${response.status}`);
  return value as T;
}

import createClient from "openapi-fetch";
import type { paths, components } from "./generated/api";

export const client = createClient<paths>();
export type Bootstrap = components["schemas"]["Bootstrap"];
export type Format = components["schemas"]["Format"];

export async function loadFoundation(signal: AbortSignal) {
  const [bootstrap, formats] = await Promise.all([
    client.GET("/api/v1/bootstrap", { signal }),
    client.GET("/api/v1/formats", { signal }),
  ]);
  if (!bootstrap.data || !formats.data)
    throw new Error("Application service unavailable");
  return { bootstrap: bootstrap.data, formats: formats.data };
}

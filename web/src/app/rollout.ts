import { useEffect, useState } from "react";
import { client } from "../api";

// The workflows behind a gate (v0.9.13, api/rollout.py): SysOp stages each one off, for staff, or
// on, and the page shows the way into one only when the account may reach it. Asked for once a
// page load: a stage SysOp changes is seen at the next one.

let asked: Promise<Record<string, boolean>> | null = null;

function reach(): Promise<Record<string, boolean>> {
  asked ??= client
    .GET("/api/v1/rollout")
    .then(({ data }) =>
      Object.fromEntries(
        (data?.workflows ?? []).map((workflow) => [
          workflow.id,
          workflow.available,
        ]),
      ),
    )
    .catch(() => ({}));
  return asked;
}

/** Forgets what was asked: the account changed, or a test starts again. */
export function forgetRollout(): void {
  asked = null;
}

/** Whether the account may reach the workflow now; false until the answer comes. */
export function useWorkflow(id: string): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let current = true;
    void reach().then((found) => {
      if (current) setAvailable(found[id] === true);
    });
    return () => {
      current = false;
    };
  }, [id]);
  return available;
}

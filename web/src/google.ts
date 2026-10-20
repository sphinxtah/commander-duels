/** Google Identity Services, loaded only when the sign-in button is about to be shown. */

export type CredentialResponse = { credential: string; select_by?: string };

export interface GoogleId {
  initialize(config: {
    client_id: string;
    nonce: string;
    callback: (response: CredentialResponse) => void;
    ux_mode?: "popup";
    use_fedcm_for_button?: boolean;
    auto_select?: boolean;
    itp_support?: boolean;
    context?: "signin" | "signup" | "use";
  }): void;
  renderButton(
    parent: HTMLElement,
    // click_listener runs when the button is pressed, before Google's window opens.
    options: Record<string, string | number | boolean | (() => void)>,
  ): void;
  disableAutoSelect(): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleId } };
  }
}

const SCRIPT = "https://accounts.google.com/gsi/client";
let loading: Promise<GoogleId> | undefined;

export function loadGoogle(): Promise<GoogleId> {
  loading ??= new Promise<GoogleId>((resolve, reject) => {
    const ready = () => window.google?.accounts?.id;
    const existing = ready();
    if (existing) return resolve(existing);
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => {
      const id = ready();
      if (id) resolve(id);
      else reject(new Error("Google sign-in did not start."));
    };
    script.onerror = () => {
      loading = undefined;
      script.remove();
      reject(
        new Error(
          "Google sign-in could not be loaded. Check the connection and try again.",
        ),
      );
    };
    document.head.append(script);
  });
  return loading;
}

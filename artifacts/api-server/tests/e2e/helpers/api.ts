import { env } from "./env";

export interface ApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
}

// Petit wrapper autour de fetch : renvoie toujours { status, ok, body }
// et ne throw jamais sur un statut HTTP != 2xx (on veut asserter dessus).
export async function apiPost<T = any>(
  path: string,
  payload: unknown,
  headers: Record<string, string> = {}
): Promise<ApiResponse<T>> {
  const res = await fetch(env.API_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });

  // Certaines réponses (secret invalide) peuvent ne pas être du JSON : on protège.
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return { status: res.status, ok: res.ok, body: body as T };
}

// Authentifie l'utilisateur de test contre Supabase et renvoie son access_token.
export async function login(): Promise<string> {
  const res = await fetch(
    `${env.SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: env.TEST_EMAIL,
        password: env.TEST_PASSWORD,
      }),
    }
  );
  const data = (await res.json()) as { access_token?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(`Login échoué : ${data.error_description || res.status}`);
  }
  return data.access_token;
}

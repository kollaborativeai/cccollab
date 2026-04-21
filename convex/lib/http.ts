export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      'Content-Type': 'application/json',
    },
  })
}

export function errorResponse(status: number, error: string, description?: string): Response {
  return jsonResponse({ error, error_description: description }, { status })
}

export async function readJsonBody<T = unknown>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    throw new Error('Invalid JSON body')
  }
}

export async function readFormBody(req: Request): Promise<URLSearchParams> {
  const text = await req.text()
  return new URLSearchParams(text)
}

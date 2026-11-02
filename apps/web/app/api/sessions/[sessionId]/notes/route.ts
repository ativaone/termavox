import { getAuthRuntime } from '../../../../../lib/auth/server.ts';
import { getNotesResponse, postNoteResponse } from '../../../../../lib/notes-api.ts';

interface Context {
  params: Promise<{ sessionId: string }>;
}

// The notes of a session of the signed-in user (plan D-58): GET lists them, POST adds one. Other
// methods get 405.
export async function GET(request: Request, context: Context): Promise<Response> {
  const { sessionId } = await context.params;
  return getNotesResponse(getAuthRuntime(), request, sessionId);
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { sessionId } = await context.params;
  return postNoteResponse(getAuthRuntime(), request, sessionId);
}

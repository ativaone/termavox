import { getAuthRuntime } from '../../../../../../lib/auth/server.ts';
import {
  deleteNoteResponse,
  getNoteResponse,
  patchNoteResponse,
} from '../../../../../../lib/notes-api.ts';

interface Context {
  params: Promise<{ sessionId: string; noteId: string }>;
}

// One note of a session of the signed-in user (plan D-58): GET, PATCH with If-Match → 409 on a
// stale revision, DELETE. Other methods get 405.
export async function GET(request: Request, context: Context): Promise<Response> {
  const { sessionId, noteId } = await context.params;
  return getNoteResponse(getAuthRuntime(), request, sessionId, noteId);
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { sessionId, noteId } = await context.params;
  return patchNoteResponse(getAuthRuntime(), request, sessionId, noteId);
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const { sessionId, noteId } = await context.params;
  return deleteNoteResponse(getAuthRuntime(), request, sessionId, noteId);
}

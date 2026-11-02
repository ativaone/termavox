import { getAuthRuntime } from '../../../../lib/auth/server.ts';
import { getNoteCountsResponse } from '../../../../lib/notes-api.ts';

// How many notes each session of the signed-in user has (plan D-58). Other methods get 405.
export async function GET(request: Request): Promise<Response> {
  return getNoteCountsResponse(getAuthRuntime(), request);
}

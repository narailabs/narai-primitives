/**
 * Meetings action specs: online meetings list / get, transcripts (list +
 * VTT content), recordings (list + binary), and a local fan-out
 * `search_meeting_transcripts` that fetches each meeting's first transcript
 * and substring-searches the VTT text.
 *
 * Every action is `{ kind: "read" }`. The recording-content handler returns
 * `{filename, media_type, size_bytes, checksum, source_url}` without running
 * text extraction (recordings are video/audio).
 */
import { ConnectorError, throwIfHttpError } from "narai-primitives/toolkit";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { TeamsActions } from "./_types.js";
import { MAX_RESULTS_DEFAULT, capMax } from "./_pagination.js";

const meetingIdField = z.string().min(1, "meeting_id required");
const transcriptIdField = z.string().min(1, "transcript_id required");
const recordingIdField = z.string().min(1, "recording_id required");
const isoField = z.string().min(1, "ISO datetime required");

const listMeetingsParams = z.object({
  since: isoField,
  until: isoField.optional(),
  max_results: z.coerce.number().int().positive().default(MAX_RESULTS_DEFAULT),
});

const getMeetingParams = z.object({
  meeting_id: meetingIdField,
});

const listMeetingTranscriptsParams = z.object({
  meeting_id: meetingIdField,
  max_results: z.coerce.number().int().positive().default(MAX_RESULTS_DEFAULT),
});

const getMeetingTranscriptParams = z.object({
  meeting_id: meetingIdField,
  transcript_id: transcriptIdField,
});

const listMeetingRecordingsParams = z.object({
  meeting_id: meetingIdField,
  max_results: z.coerce.number().int().positive().default(MAX_RESULTS_DEFAULT),
});

const getMeetingRecordingParams = z.object({
  meeting_id: meetingIdField,
  recording_id: recordingIdField,
});

const SEARCH_DEFAULT_MEETINGS = 50;
const SEARCH_MAX_MEETINGS = 200;
const SEARCH_DEFAULT_PER_MEETING = 1;
const SEARCH_MAX_PER_MEETING = 5;

const searchTranscriptsParams = z.object({
  query: z.string().min(1, "search_meeting_transcripts requires a non-empty 'query'"),
  since: isoField,
  until: isoField.optional(),
  max_meetings: z.coerce.number().int().positive().default(SEARCH_DEFAULT_MEETINGS),
  max_transcripts_per_meeting: z.coerce
    .number()
    .int()
    .positive()
    .default(SEARCH_DEFAULT_PER_MEETING),
});

function buildFilter(since: string, until: string | undefined): string {
  const u = until ?? new Date().toISOString();
  return `startDateTime ge ${since} and startDateTime le ${u}`;
}

function snippetAround(text: string, idx: number, window = 300): string {
  const start = Math.max(0, idx - Math.floor(window / 2));
  const end = Math.min(text.length, start + window);
  return text.slice(start, end);
}

export function buildMeetingsActions(): TeamsActions {
  return {
    list_meetings: {
      description: "List the signed-in user's online meetings in a date range",
      params: listMeetingsParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof listMeetingsParams>, ctx) => {
        const max = capMax(p.max_results);
        const filter = buildFilter(p.since, p.until);
        const r = await ctx.sdk.listOnlineMeetings(filter, max);
        throwIfHttpError(r);
        return {
          since: p.since,
          until: p.until ?? null,
          total: r.data.items.length,
          truncated: r.data.truncated,
          meetings: r.data.items.map((m) => ({
            id: m.id,
            subject: m.subject ?? null,
            start_at: m.startDateTime ?? null,
            end_at: m.endDateTime ?? null,
            join_web_url: m.joinWebUrl ?? null,
            join_meeting_id: m.joinMeetingId ?? null,
          })),
        };
      },
    },

    get_meeting: {
      description: "Fetch a single online meeting by id",
      params: getMeetingParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getMeetingParams>, ctx) => {
        const r = await ctx.sdk.getOnlineMeeting(p.meeting_id);
        throwIfHttpError(r);
        const m = r.data;
        return {
          id: m.id,
          subject: m.subject ?? null,
          start_at: m.startDateTime ?? null,
          end_at: m.endDateTime ?? null,
          join_web_url: m.joinWebUrl ?? null,
          join_meeting_id: m.joinMeetingId ?? null,
        };
      },
    },

    list_meeting_transcripts: {
      description: "List transcripts on an online meeting",
      params: listMeetingTranscriptsParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof listMeetingTranscriptsParams>, ctx) => {
        const max = capMax(p.max_results);
        const r = await ctx.sdk.listMeetingTranscripts(p.meeting_id, max);
        throwIfHttpError(r);
        return {
          meeting_id: p.meeting_id,
          total: r.data.items.length,
          truncated: r.data.truncated,
          transcripts: r.data.items.map((t) => ({
            id: t.id,
            created_at: t.createdDateTime ?? null,
            transcript_content_url: t.transcriptContentUrl ?? null,
          })),
        };
      },
    },

    get_meeting_transcript: {
      description: "Fetch a meeting transcript's content as WebVTT text",
      params: getMeetingTranscriptParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getMeetingTranscriptParams>, ctx) => {
        const r = await ctx.sdk.getMeetingTranscriptContent(
          p.meeting_id,
          p.transcript_id,
        );
        throwIfHttpError(r);
        return {
          meeting_id: p.meeting_id,
          transcript_id: p.transcript_id,
          format: "vtt",
          text: r.data,
        };
      },
    },

    list_meeting_recordings: {
      description: "List recordings on an online meeting",
      params: listMeetingRecordingsParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof listMeetingRecordingsParams>, ctx) => {
        const max = capMax(p.max_results);
        const r = await ctx.sdk.listMeetingRecordings(p.meeting_id, max);
        throwIfHttpError(r);
        return {
          meeting_id: p.meeting_id,
          total: r.data.items.length,
          truncated: r.data.truncated,
          recordings: r.data.items.map((rec) => ({
            id: rec.id,
            created_at: rec.createdDateTime ?? null,
            recording_content_url: rec.recordingContentUrl ?? null,
            call_id: rec.callId ?? null,
          })),
        };
      },
    },

    get_meeting_recording: {
      description: "Fetch a recording's bytes (returns metadata + checksum; no text extraction)",
      params: getMeetingRecordingParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof getMeetingRecordingParams>, ctx) => {
        const r = await ctx.sdk.getMeetingRecordingContent(
          p.meeting_id,
          p.recording_id,
        );
        throwIfHttpError(r);
        const bin = r.data;
        const checksum = createHash("sha256").update(bin.bytes).digest("hex");
        return {
          meeting_id: p.meeting_id,
          recording_id: p.recording_id,
          filename: bin.filename,
          media_type: bin.contentType,
          size_bytes: bin.bytes.byteLength,
          checksum,
          source_url: `https://graph.microsoft.com/v1.0/me/onlineMeetings/${p.meeting_id}/recordings/${p.recording_id}/content`,
        };
      },
    },

    search_meeting_transcripts: {
      description:
        "Search meeting transcripts in a date range for a substring (case-insensitive); fan-out across meetings",
      params: searchTranscriptsParams,
      classify: { kind: "read" },
      handler: async (p: z.infer<typeof searchTranscriptsParams>, ctx) => {
        const maxMeetings = Math.min(p.max_meetings, SEARCH_MAX_MEETINGS);
        const maxPerMeeting = Math.min(
          p.max_transcripts_per_meeting,
          SEARCH_MAX_PER_MEETING,
        );
        const filter = buildFilter(p.since, p.until);
        const meetingsRes = await ctx.sdk.listOnlineMeetings(filter, maxMeetings);
        throwIfHttpError(meetingsRes);
        const meetings = meetingsRes.data.items;
        const queryLower = p.query.toLowerCase();
        const matches: Array<{
          meeting_id: string;
          meeting_subject: string | null;
          transcript_id: string;
          snippet: string;
          match_count: number;
        }> = [];
        let meetingsSearched = 0;
        let transcriptsSearched = 0;
        for (const meeting of meetings) {
          meetingsSearched++;
          const transcriptsRes = await ctx.sdk.listMeetingTranscripts(
            meeting.id,
            maxPerMeeting,
          );
          if (!transcriptsRes.ok) {
            // Skip meetings whose transcripts the user cannot read (forbidden,
            // not-found, etc.) — surfacing a fatal error here would defeat the
            // fan-out helper.
            if (transcriptsRes.status === 403 || transcriptsRes.status === 404) {
              continue;
            }
            throw new ConnectorError(
              transcriptsRes.code,
              transcriptsRes.message,
              transcriptsRes.retriable,
              transcriptsRes.status,
            );
          }
          const transcripts = transcriptsRes.data.items.slice(0, maxPerMeeting);
          for (const t of transcripts) {
            transcriptsSearched++;
            const contentRes = await ctx.sdk.getMeetingTranscriptContent(
              meeting.id,
              t.id,
            );
            if (!contentRes.ok) {
              if (contentRes.status === 403 || contentRes.status === 404) continue;
              throw new ConnectorError(
                contentRes.code,
                contentRes.message,
                contentRes.retriable,
                contentRes.status,
              );
            }
            const text = contentRes.data;
            const lower = text.toLowerCase();
            const idx = lower.indexOf(queryLower);
            if (idx === -1) continue;
            // Count occurrences for visibility.
            let count = 0;
            let pos = 0;
            while ((pos = lower.indexOf(queryLower, pos)) !== -1) {
              count++;
              pos += queryLower.length;
            }
            matches.push({
              meeting_id: meeting.id,
              meeting_subject: meeting.subject ?? null,
              transcript_id: t.id,
              snippet: snippetAround(text, idx),
              match_count: count,
            });
          }
        }
        return {
          query: p.query,
          since: p.since,
          until: p.until ?? null,
          meetings_searched: meetingsSearched,
          transcripts_searched: transcriptsSearched,
          total_matches: matches.length,
          matches,
        };
      },
    },
  };
}

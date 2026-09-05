import { useEffect, useRef, useState } from "react";
import { supabase } from "./lib/supabase";

type Player = {
  id: string;
  room_id: string;
  user_id: string;
  name: string;
  is_host: boolean;
};

type Room = {
  id: string;
  code: string;
  host_id: string;
  status: string;
  announcement?: string | null;
  winner?: string | null;
  discuss_seconds?: number | null;
  discuss_ends_at?: string | null;
  mafia_can_kill?: boolean | null;
  include_mafia?: boolean | null;
  include_doctor?: boolean | null;
  include_detective?: boolean | null;
  include_jester?: boolean | null;
};

const DEFAULT_DISCUSS_SECONDS = 150;
const LOBBY_SETTINGS_SQL_HINT =
  "Run supabase/lobby_settings.sql in the Supabase SQL editor (the whole file), wait a few seconds, then try again.";

function isMissingRoomsColumn(message: string) {
  return /schema cache|Could not find the '.+' column of 'rooms'/i.test(
    message,
  );
}

const ROLE_TEXT: Record<string, { title: string; blurb: string }> = {
  civilian: {
    title: "Civilian",
    blurb: "Find the mafia. Vote them out during the day.",
  },
  mafia: {
    title: "Mafia",
    blurb: "Kill at night. Do not get voted out.",
  },
  doctor: {
    title: "Doctor",
    blurb:
      "Each night save yourself or someone else. You cannot save the same person two nights in a row.",
  },
  detective: {
    title: "Detective",
    blurb: "Each night learn if one player is mafia or not.",
  },
  jester: {
    title: "Jester",
    blurb: "You win only if the town votes you out.",
  },
};

const NIGHT_KILL_STORIES = [
  "{name} was found at first light, still in the street. Nobody heard a thing.",
  "They knocked on {name}'s door at dawn. The kettle was cold.",
  "{name} never came back from the well. The bucket was still there.",
  "A coat hung on the fence. Under it, {name} did not wake.",
  "{name} missed the morning bell. The house was unlocked.",
  "Tracks stopped in the square. That is where they found {name}.",
  "{name}'s candle burned down to the dish. The chair was empty.",
  "Someone closed {name}'s eyes before the town could gather.",
  "The river path held {name} until sunrise. No one else was in sight.",
  "{name} had set two cups out. Only one was used.",
];

const NIGHT_SAVE_STORIES = [
  "{name} was left for dead. At dawn they were bandaged and breathing.",
  "The town almost lost {name}. They opened their eyes before anyone could explain it.",
  "{name} was attacked in the dark. Whoever stayed behind left no name.",
  "Blood on the stoop. {name} is alive. That is the whole report.",
  "{name} collapsed after midnight and sat up at first light.",
  "They came for {name}. Dawn found them shaken, not gone.",
  "{name} remembers a struggle, then waking under a blanket that was not theirs.",
  "A window broke at {name}'s house. They still answered the morning roll.",
  "{name} should have been a body in the lane. They walked home instead.",
  "The night reached for {name} and missed. They will not say more.",
];

function nightStory(templates: string[], name: string) {
  const story =
    templates[Math.floor(Math.random() * templates.length)] ?? templates[0];
  return story.replaceAll("{name}", name);
}

function isQuietNightText(text: string | null | undefined) {
  return /streets were empty|nobody is missing|nobody was missing/i.test(
    text ?? "",
  );
}

function playerMentioned(text: string, playerName: string) {
  if (!text || !playerName) return false;
  return text.toLowerCase().includes(playerName.trim().toLowerCase());
}

function resolveNightOutcome(
  people: { id: string; user_id: string; name: string; is_alive: boolean; role: string | null }[],
  actions: { player_id: string; target_id: string | null }[] | null,
  priorAnnouncement: string | null,
) {
  const actedAs = (id: string, role: string) =>
    people.some(
      (p) =>
        p.role === role &&
        (p.id === id || p.user_id === id),
    );
  const byId = (id: string | null | undefined) =>
    people.find((p) => p.id === id || p.user_id === id);
  const mafiaTarget = [...(actions ?? [])]
    .reverse()
    .find((a) => a.target_id && actedAs(a.player_id, "mafia"))?.target_id;
  const doctorTarget = [...(actions ?? [])]
    .reverse()
    .find((a) => a.target_id && actedAs(a.player_id, "doctor"))?.target_id;
  const victim = byId(mafiaTarget);
  if (victim && victim.is_alive === false) {
    return { kind: "kill" as const, name: victim.name };
  }
  if (
    victim &&
    doctorTarget &&
    (doctorTarget === mafiaTarget || doctorTarget === victim.id)
  ) {
    return { kind: "save" as const, name: victim.name };
  }

  const prior = priorAnnouncement ?? "";
  const mentioned = [...people]
    .sort((a, b) => b.name.length - a.name.length)
    .find((p) => playerMentioned(prior, p.name));
  if (mentioned && mentioned.is_alive === false) {
    return { kind: "kill" as const, name: mentioned.name };
  }
  if (mentioned && mentioned.is_alive !== false && !isQuietNightText(prior)) {
    return { kind: "save" as const, name: mentioned.name };
  }

  const dead = people.filter((p) => p.is_alive === false);
  if (dead.length === 1) {
    return { kind: "kill" as const, name: dead[0].name };
  }
  return { kind: "quiet" as const, name: null };
}

function formatNightAnnouncement(kind: "kill" | "save" | "quiet", name: string | null) {
  if (kind === "kill" && name) {
    return `${nightStory(NIGHT_KILL_STORIES, name)}\n\nKilled: ${name}`;
  }
  if (kind === "save" && name) {
    return `${nightStory(NIGHT_SAVE_STORIES, name)}\n\nSurvived: ${name}`;
  }
  return "The streets were empty till dawn. Nobody is missing.";
}

function nightAnnouncementView(text: string | null | undefined) {
  const raw = text ?? "";
  const killed = raw.match(/\nKilled:\s*(.+)\s*$/m)?.[1]?.trim() ?? null;
  const survived = raw.match(/\nSurvived:\s*(.+)\s*$/m)?.[1]?.trim() ?? null;
  const story = raw.replace(/\n\n(?:Killed|Survived):[\s\S]*$/m, "").trim();
  return { story, killed, survived };
}

function formatClock(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

const RESERVED_PLAYER_NAMES = new Set([
  "mafia",
  "doctor",
  "detective",
  "jester",
  "civilian",
]);

function playerNameError(raw: string): string | null {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return "Type a name first";
  if (RESERVED_PLAYER_NAMES.has(trimmed.toLowerCase())) {
    return "That name is a role. Pick a different one.";
  }
  return null;
}

function rpcMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message
  ) {
    return error.message;
  }
  return fallback;
}

async function ensureSignedIn() {
  const { data } = await supabase.auth.getSession();
  if (data.session?.user) return data.session.user;
  const { data: signed, error } = await supabase.auth.signInAnonymously();
  if (error || !signed.user) throw error ?? new Error("Sign in failed");
  return signed.user;
}

export default function App() {
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [room, setRoom] = useState<Room | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [myRole, setMyRole] = useState<string | null>(null);
  const [living, setLiving] = useState<
    {
      id: string;
      name: string;
      user_id: string;
      is_alive: boolean;
      role: string | null;
    }[]
  >([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const prevStatusRef = useRef<string | null>(null);
  const joinedRoomIdRef = useRef<string | null>(null);
  const advancingDiscussRef = useRef(false);
  const localDiscussEndRef = useRef<number | null>(null);
  const nightStoryKeyRef = useRef<string | null>(null);
  const [discussSeconds, setDiscussSeconds] = useState(DEFAULT_DISCUSS_SECONDS);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [mafiaCanKill, setMafiaCanKill] = useState(true);
  const [includeDoctor, setIncludeDoctor] = useState(true);
  const [includeDetective, setIncludeDetective] = useState(true);
  const [includeJester, setIncludeJester] = useState(true);

  const me = players.find((p) => p.user_id === myUserId);
  const canStart =
    Boolean(me?.is_host) && players.length >= 4 && room?.status === "lobby";

  async function loadPlayers(roomId: string) {
    const { data, error } = await supabase
      .from("players")
      .select("id, room_id, user_id, name, is_host")
      .eq("room_id", roomId);
    if (error) setError(error.message);
    if (data) setPlayers(data as Player[]);
  }

  async function loadMyRole(roomId: string, userId: string) {
    const { data } = await supabase
      .from("players")
      .select("role")
      .eq("room_id", roomId)
      .eq("user_id", userId)
      .single();
    if (data?.role) setMyRole(data.role);
  }

  async function loadLiving(roomId: string) {
    const { data } = await supabase
      .from("players")
      .select("id, name, user_id, is_alive, role")
      .eq("room_id", roomId);
    if (data) setLiving(data as any);
  }

  async function loadNote(roomId: string, userId: string) {
    const { data: row } = await supabase
      .from("players")
      .select("id")
      .eq("room_id", roomId)
      .eq("user_id", userId)
      .single();
    if (!row) {
      setNote(null);
      return;
    }
    const { data } = await supabase
      .from("private_notes")
      .select("message")
      .eq("room_id", roomId)
      .eq("player_id", row.id)
      .order("night_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    setNote(data?.message ?? null);
  }

  async function refreshRoom(roomId: string) {
    if (joinedRoomIdRef.current !== roomId) return;
    const { data } = await supabase
      .from("rooms")
      .select("*")
      .eq("id", roomId)
      .single();
    if (joinedRoomIdRef.current !== roomId) return;
    if (data) setRoom(data as Room);
  }

  function enterRoom(next: Room) {
    joinedRoomIdRef.current = next.id;
    setRoom(next);
  }

  function clearLocalGame() {
    joinedRoomIdRef.current = null;
    setRoom(null);
    setPlayers([]);
    setLiving([]);
    setMyRole(null);
    setPicked(null);
    setNote(null);
    prevStatusRef.current = null;
  }
  useEffect(() => {
    async function restore() {
      const { data } = await supabase.auth.getSession();
      const user = data.session?.user;
      if (!user) return;
      setMyUserId(user.id);

      const { data: row } = await supabase
        .from("players")
        .select("room_id")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!row) return;

      const { data: existing } = await supabase
        .from("rooms")
        .select("*")
        .eq("id", row.room_id)
        .maybeSingle();

      if (existing && existing.status !== "ended") {
        enterRoom(existing as Room);
      }
    }

    restore();
  }, []);

  useEffect(() => {
    if (!room) return;

    loadPlayers(room.id);
    loadLiving(room.id);
    if (myUserId) {
      loadMyRole(room.id, myUserId);
      loadNote(room.id, myUserId);
    }

    const channel = supabase
      .channel(`room-${room.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "players",
          filter: `room_id=eq.${room.id}`,
        },
        () => {
          loadPlayers(room.id);
          loadLiving(room.id);
          if (myUserId) {
            loadMyRole(room.id, myUserId);
            loadNote(room.id, myUserId);
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "rooms",
          filter: `id=eq.${room.id}`,
        },
        () => {
          refreshRoom(room.id);
          loadLiving(room.id);
          if (myUserId) {
            loadMyRole(room.id, myUserId);
            loadNote(room.id, myUserId);
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [room?.id, myUserId]);

  useEffect(() => {
    prevStatusRef.current = null;
  }, [room?.id]);

  useEffect(() => {
    if (!room || !myUserId) return;
    if (room.status === "lobby" || room.status === "ended") return;

    const statusChanged = prevStatusRef.current !== room.status;
    if (statusChanged && (room.status === "night" || room.status === "day")) {
      setPicked(null);
    }
    prevStatusRef.current = room.status;

    loadMyRole(room.id, myUserId);
    loadLiving(room.id);
    loadNote(room.id, myUserId);

    const t = setInterval(() => {
      loadMyRole(room.id, myUserId);
      loadLiving(room.id);
      loadNote(room.id, myUserId);
      refreshRoom(room.id);
    }, 1000);

    return () => clearInterval(t);
  }, [room?.id, room?.status, myUserId]);

  useEffect(() => {
    if (room?.discuss_seconds && room.discuss_seconds > 0) {
      setDiscussSeconds(room.discuss_seconds);
    }
  }, [room?.id, room?.discuss_seconds]);

  useEffect(() => {
    if (!room || !me?.is_host) return;
    if (room.status !== "dawn" && room.status !== "discuss") {
      nightStoryKeyRef.current = null;
      return;
    }
    const key = `${room.id}:${room.discuss_ends_at ?? "dawn"}`;
    if (nightStoryKeyRef.current === key) return;
    if (living.length === 0) return;
    nightStoryKeyRef.current = key;
    void (async () => {
      const { data: actions } = await supabase
        .from("night_actions")
        .select("player_id, target_id")
        .eq("room_id", room.id);
      let outcome = resolveNightOutcome(
        living,
        actions ?? [],
        room.announcement ?? "",
      );
      if (outcome.kind === "quiet") {
        const { data } = await supabase.rpc("apply_night_story", {
          p_room_id: room.id,
        });
        if (typeof data === "string" && data && !isQuietNightText(data)) {
          setRoom((prev) =>
            prev && prev.id === room.id ? { ...prev, announcement: data } : prev,
          );
          return;
        }
        const dead = living.filter((p) => p.is_alive === false);
        if (dead.length === 1) {
          outcome = { kind: "kill", name: dead[0].name };
        }
      }
      const story = formatNightAnnouncement(outcome.kind, outcome.name);
      await supabase
        .from("rooms")
        .update({ announcement: story })
        .eq("id", room.id);
      setRoom((prev) =>
        prev && prev.id === room.id ? { ...prev, announcement: story } : prev,
      );
    })();
  }, [
    room?.id,
    room?.status,
    room?.discuss_ends_at,
    me?.is_host,
    living,
  ]);

  useEffect(() => {
    if (!room) return;
    setMafiaCanKill(room.mafia_can_kill !== false);
    setIncludeDoctor(room.include_doctor !== false);
    setIncludeDetective(room.include_detective !== false);
    setIncludeJester(room.include_jester !== false);
  }, [room?.id]);

  useEffect(() => {
    if (room?.status === "day" && /tied|vote again/i.test(room.announcement ?? "")) {
      setPicked(null);
    }
  }, [room?.announcement, room?.status]);

  useEffect(() => {
    if (room?.status !== "dawn" && room?.status !== "discuss") {
      advancingDiscussRef.current = false;
      localDiscussEndRef.current = null;
      return;
    }
    if (room.discuss_ends_at) {
      localDiscussEndRef.current = new Date(room.discuss_ends_at).getTime();
    } else if (localDiscussEndRef.current === null) {
      localDiscussEndRef.current =
        Date.now() +
        (room.discuss_seconds ?? discussSeconds ?? DEFAULT_DISCUSS_SECONDS) *
          1000;
    }
    const tick = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(tick);
  }, [
    room?.status,
    room?.discuss_ends_at,
    room?.discuss_seconds,
    discussSeconds,
  ]);

  useEffect(() => {
    if (!room || (room.status !== "dawn" && room.status !== "discuss")) return;
    const end = room.discuss_ends_at
      ? new Date(room.discuss_ends_at).getTime()
      : localDiscussEndRef.current;
    if (end === null || Number.isNaN(end)) return;
    if (nowMs < end) return;
    if (advancingDiscussRef.current) return;
    advancingDiscussRef.current = true;
    void (async () => {
      await supabase.rpc("begin_day");
      await refreshRoom(room.id);
      window.setTimeout(() => {
        advancingDiscussRef.current = false;
      }, 2000);
    })();
  }, [nowMs, room?.id, room?.status, room?.discuss_ends_at]);

  useEffect(() => {
    if (!room) return;
    if (room.status !== "night" && room.status !== "reveal") return;
    if (room.mafia_can_kill !== false) return;
    void supabase.rpc("skip_disarmed_mafia", { p_room_id: room.id });
  }, [room?.id, room?.status, room?.mafia_can_kill]);

  async function createRoom() {
    setError("");
    const nameProblem = playerNameError(name);
    if (nameProblem) {
      setError(nameProblem);
      return;
    }
    setBusy(true);
    try {
      const user = await ensureSignedIn();
      setMyUserId(user.id);
      const code = randomCode();
      const payload: Record<string, unknown> = {
        code,
        host_id: user.id,
        status: "lobby",
        discuss_seconds: DEFAULT_DISCUSS_SECONDS,
        mafia_can_kill: true,
        include_mafia: true,
        include_doctor: includeDoctor,
        include_detective: includeDetective,
        include_jester: includeJester,
      };
      let { data: newRoom, error: roomError } = await supabase
        .from("rooms")
        .insert(payload)
        .select()
        .single();
      if (roomError) {
        const withoutRoles = await supabase
          .from("rooms")
          .insert({
            code,
            host_id: user.id,
            status: "lobby",
            discuss_seconds: DEFAULT_DISCUSS_SECONDS,
          })
          .select()
          .single();
        newRoom = withoutRoles.data;
        roomError = withoutRoles.error;
      }
      if (roomError) {
        const retry = await supabase
          .from("rooms")
          .insert({ code, host_id: user.id, status: "lobby" })
          .select()
          .single();
        newRoom = retry.data;
        roomError = retry.error;
      }
      if (roomError || !newRoom) throw roomError ?? new Error("Could not create room");
      const { error: playerError } = await supabase.from("players").insert({
        room_id: newRoom.id,
        user_id: user.id,
        name: name.trim(),
        is_host: true,
      });
      if (playerError) throw playerError;
      enterRoom(newRoom as Room);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create room");
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom() {
    setError("");
    const nameProblem = playerNameError(name);
    if (nameProblem) {
      setError(nameProblem);
      return;
    }
    if (joinCode.trim().length !== 6) {
      setError("Enter the 6-letter room code");
      return;
    }
    setBusy(true);
    try {
      const user = await ensureSignedIn();
      setMyUserId(user.id);
      const code = joinCode.trim().toUpperCase();
      const { data: found, error: findError } = await supabase
        .from("rooms")
        .select("*")
        .eq("code", code)
        .single();
      if (findError || !found) throw new Error("No room with that code");
      if (found.status !== "lobby")
        throw new Error("That game already started");
      const { error: playerError } = await supabase.from("players").insert({
        room_id: found.id,
        user_id: user.id,
        name: name.trim(),
        is_host: false,
      });
      if (playerError) throw playerError;
      enterRoom(found as Room);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not join room");
    } finally {
      setBusy(false);
    }
  }

  async function startGame() {
    if (!room) return;
    setError("");
    setBusy(true);
    try {
      const { error: settingsError } = await supabase
        .from("rooms")
        .update({
          discuss_seconds: discussSeconds,
          mafia_can_kill: mafiaCanKill,
          include_mafia: true,
          include_doctor: includeDoctor,
          include_detective: includeDetective,
          include_jester: includeJester,
        })
        .eq("id", room.id);
      if (settingsError) {
        throw new Error(
          isMissingRoomsColumn(settingsError.message)
            ? LOBBY_SETTINGS_SQL_HINT
            : settingsError.message,
        );
      }
      const { error } = await supabase.rpc("start_game", {
        p_room_id: room.id,
      });
      if (error) throw error;
      const { error: dealError } = await supabase.rpc("deal_configured_roles", {
        p_room_id: room.id,
        p_include_doctor: includeDoctor,
        p_include_detective: includeDetective,
        p_include_jester: includeJester,
      });
      if (dealError) {
        throw new Error(
          dealError.message.includes("deal_configured_roles")
            ? LOBBY_SETTINGS_SQL_HINT
            : dealError.message,
        );
      }
      const { error: shuffleError } = await supabase.rpc("shuffle_room_roles", {
        p_room_id: room.id,
      });
      if (shuffleError && !shuffleError.message.includes("shuffle_room_roles")) {
        throw new Error(shuffleError.message);
      }
      await refreshRoom(room.id);
      if (myUserId) await loadMyRole(room.id, myUserId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start");
    } finally {
      setBusy(false);
    }
  }

  async function submitNight(targetId: string) {
    setError("");
    setBusy(true);
    try {
      const { error } = await supabase.rpc("submit_night_action", {
        p_target_id: targetId,
      });
      if (error) throw error;
      setPicked(targetId);
      if (room && myUserId) {
        await loadNote(room.id, myUserId);
        await refreshRoom(room.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveLobbySettings(
    patch: Partial<{
      mafia_can_kill: boolean;
      include_doctor: boolean;
      include_detective: boolean;
      include_jester: boolean;
    }>,
  ) {
    if (patch.mafia_can_kill !== undefined) setMafiaCanKill(patch.mafia_can_kill);
    if (patch.include_doctor !== undefined) setIncludeDoctor(patch.include_doctor);
    if (patch.include_detective !== undefined)
      setIncludeDetective(patch.include_detective);
    if (patch.include_jester !== undefined) setIncludeJester(patch.include_jester);
    if (!room || !me?.is_host || room.status !== "lobby") return;
    const { error } = await supabase.from("rooms").update(patch).eq("id", room.id);
    if (error) {
      setError(
        isMissingRoomsColumn(error.message)
          ? LOBBY_SETTINGS_SQL_HINT
          : error.message,
      );
    }
  }

  async function saveDiscussSeconds(next: number) {
    const secs = Math.min(30 * 60, Math.max(15, next));
    setDiscussSeconds(secs);
    if (!room || !me?.is_host || room.status !== "lobby") return;
    const { error } = await supabase
      .from("rooms")
      .update({ discuss_seconds: secs })
      .eq("id", room.id);
    if (error) setError(error.message);
  }

  async function goToVote() {
    if (!me?.is_host) return;
    setError("");
    setBusy(true);
    try {
      const { error } = await supabase.rpc("begin_day");
      if (error) throw error;
      setPicked(null);
      if (room) await refreshRoom(room.id);
    } catch (e) {
      setError(rpcMessage(e, "Could not start vote"));
    } finally {
      setBusy(false);
    }
  }

  async function submitVote(targetId: string) {
    setError("");
    setBusy(true);
    try {
      const { error } = await supabase.rpc("submit_vote", {
        p_target_id: targetId,
      });
      if (error) throw error;
      setPicked(targetId);
      if (room) await refreshRoom(room.id);
    } catch (e) {
      setError(rpcMessage(e, "Vote failed"));
    } finally {
      setBusy(false);
    }
  }

  async function leaveGame() {
    const roomId = room?.id;
    setError("");
    setBusy(true);
    joinedRoomIdRef.current = null;
    try {
      const { error } = await supabase.rpc("leave_game");
      if (error && roomId && myUserId) {
        await supabase
          .from("players")
          .delete()
          .eq("room_id", roomId)
          .eq("user_id", myUserId);
      }
    } catch {
      // Still leave locally so Game over is never a trap.
    } finally {
      clearLocalGame();
      setBusy(false);
    }
  }

  if (room && room.status === "ended") {
    return (
      <main className="min-h-screen text-zinc-50 flex items-center justify-center p-6">
        <div className="w-full max-w-sm text-center space-y-4">
          <h1 className="text-4xl">Game over</h1>
          <p className="text-lg text-zinc-300">{room.announcement}</p>
          <p className="text-zinc-500">Winner: {room.winner ?? "unknown"}</p>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="button"
            onClick={leaveGame}
            disabled={busy}
            className="press-btn w-full rounded-xl bg-zinc-800 py-3 text-sm"
          >
            Leave game
          </button>
        </div>
      </main>
    );
  }

  if (room && (room.status === "dawn" || room.status === "discuss")) {
    const endMs = room.discuss_ends_at
      ? new Date(room.discuss_ends_at).getTime()
      : (localDiscussEndRef.current ?? NaN);
    const remaining = Number.isFinite(endMs)
      ? Math.max(0, Math.ceil((endMs - nowMs) / 1000))
      : DEFAULT_DISCUSS_SECONDS;

    return (
      <main className="min-h-screen text-zinc-50 flex items-center justify-center p-6">
        <div className="w-full max-w-sm text-center space-y-4">
          <h1 className="text-3xl">Discuss</h1>
          <p className="text-5xl font-display tracking-wide">{formatClock(remaining)}</p>
          {(() => {
            const night = nightAnnouncementView(room.announcement);
            return (
              <>
                <p className="text-lg text-zinc-300">
                  {night.story || "The night is over. Talk it through."}
                </p>
                {night.killed && (
                  <p className="text-red-400 text-xl font-semibold">
                    Killed: {night.killed}
                  </p>
                )}
                {night.survived && (
                  <p className="text-amber-300 text-lg font-semibold">
                    Survived: {night.survived}
                  </p>
                )}
              </>
            );
          })()}
          {note && <p className="text-amber-300">{note}</p>}
          <p className="text-zinc-500 text-sm">
            Voting starts when the timer hits zero.
          </p>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          {me?.is_host ? (
            <button
              type="button"
              onClick={goToVote}
              disabled={busy}
              className="press-btn press-btn-danger w-full rounded-xl bg-red-700 py-4 text-lg font-semibold"
            >
              Vote now
            </button>
          ) : (
            <p className="text-zinc-500 text-sm">
              The host can start the vote early.
            </p>
          )}
          <button
            type="button"
            onClick={leaveGame}
            disabled={busy}
            className="press-btn w-full rounded-xl bg-zinc-800 py-3 text-sm"
          >
            Leave game
          </button>
        </div>
      </main>
    );
  }

  if (room && room.status === "day") {
    const targets = living.filter((p) => p.is_alive && p.user_id !== myUserId);
    const amAlive = living.some((p) => p.user_id === myUserId && p.is_alive);

    return (
      <main className="min-h-screen text-zinc-50 p-6">
        <div className="mx-auto w-full max-w-sm space-y-4">
          <h1 className="text-center text-3xl">Day vote</h1>
          <p className="text-center text-zinc-400">{room.announcement}</p>
          {!amAlive && (
            <p className="text-center text-zinc-500">You are dead. Watch.</p>
          )}
          {amAlive &&
            !picked &&
            targets.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={busy}
                onClick={() => submitVote(p.id)}
                className="press-btn w-full rounded-xl bg-zinc-900 py-3"
              >
                {p.name}
              </button>
            ))}
          {amAlive && picked && (
            <p className="text-center text-zinc-500">
              Waiting for other votes…
            </p>
          )}
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="button"
            onClick={leaveGame}
            disabled={busy}
            className="press-btn w-full rounded-xl bg-zinc-800 py-3 text-sm"
          >
            Leave game
          </button>
        </div>
      </main>
    );
  }

  if (room && (room.status === "night" || room.status === "reveal")) {
    if (!myRole) {
      return (
        <main className="min-h-screen text-zinc-50 flex items-center justify-center p-6">
          <div className="w-full max-w-sm text-center space-y-4">
            <h1 className="text-3xl">Dealing roles…</h1>
            <p className="text-zinc-500">Hang on — your role is on the way.</p>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button
              type="button"
              onClick={leaveGame}
              disabled={busy}
              className="press-btn w-full rounded-xl bg-zinc-800 py-3 text-sm"
            >
              Leave game
            </button>
          </div>
        </main>
      );
    }

    const info =
      myRole === "mafia" && room.mafia_can_kill === false
        ? {
            title: "Mafia",
            blurb: "You cannot kill tonight. Blend in and survive the vote.",
          }
        : (ROLE_TEXT[myRole] ?? { title: myRole, blurb: "" });
    const amAlive = living.some((p) => p.user_id === myUserId && p.is_alive);
    const canAct =
      amAlive &&
      ((myRole === "mafia" && room.mafia_can_kill !== false) ||
        myRole === "doctor" ||
        myRole === "detective");
    const targets = living.filter((p) => {
      if (!p.is_alive) return false;
      if (
        (myRole === "mafia" || myRole === "detective") &&
        p.user_id === myUserId
      ) {
        return false;
      }
      return true;
    });

    return (
      <main className="min-h-screen text-zinc-50 p-6">
        <div className="mx-auto w-full max-w-sm space-y-4">
          <p className="text-center text-zinc-500 text-sm">You are</p>
          <h1 className="text-center text-4xl">{info.title}</h1>
          <p className="text-center text-zinc-400">{info.blurb}</p>

          {myRole === "mafia" && (
            <p className="text-center text-red-400 text-sm">
              Mafia:{" "}
              {living
                .filter((p) => p.role === "mafia")
                .map((p) => p.name)
                .join(", ") || "you"}
            </p>
          )}

          {!amAlive && (
            <p className="text-center text-zinc-500">You are dead. Watch.</p>
          )}

          {canAct && !picked && (
            <div className="space-y-2">
              <p className="text-sm text-zinc-400">
                {myRole === "mafia" && "Choose who to kill"}
                {myRole === "doctor" && "Choose who to save"}
                {myRole === "detective" && "Choose who to inspect"}
              </p>
              {targets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={busy}
                  onClick={() => submitNight(p.id)}
                  className="press-btn w-full rounded-xl bg-zinc-900 py-3"
                >
                  {p.name}
                  {p.user_id === myUserId ? " (you)" : ""}
                </button>
              ))}
            </div>
          )}

          {amAlive && (!canAct || picked) && (
            <p className="text-center text-zinc-500">
              Waiting for the night to end…
            </p>
          )}

          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="button"
            onClick={leaveGame}
            disabled={busy}
            className="press-btn w-full rounded-xl bg-zinc-800 py-3 text-sm"
          >
            Leave game
          </button>
        </div>
      </main>
    );
  }

  if (room) {
    return (
      <main className="min-h-screen text-zinc-50 p-6">
        <div className="mx-auto w-full max-w-sm space-y-6">
          <div className="text-center">
            <p className="text-zinc-400 text-sm">Room code</p>
            <p className="font-display text-4xl tracking-[0.3em] mt-1">
              {room.code}
            </p>
            <p className="text-zinc-500 text-sm mt-2">
              {players.length} / 12 joined · need 4 to start
            </p>
          </div>
          <ul className="space-y-2">
            {players.map((p) => (
              <li
                key={p.id}
                className="rounded-xl bg-zinc-900 px-4 py-3 flex justify-between"
              >
                <span>{p.name}</span>
                {p.is_host && (
                  <span className="text-zinc-500 text-sm">Host</span>
                )}
              </li>
            ))}
          </ul>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          {me?.is_host && room.status === "lobby" && (
            <div className="rounded-xl bg-zinc-900 px-4 py-3 space-y-2">
              <p className="text-sm text-zinc-400">Discussion timer</p>
              <div className="flex gap-2 items-center">
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={Math.floor(discussSeconds / 60)}
                  onChange={(e) => {
                    const minutes = Number(e.target.value);
                    const seconds = discussSeconds % 60;
                    void saveDiscussSeconds(
                      (Number.isFinite(minutes) ? minutes : 0) * 60 + seconds,
                    );
                  }}
                  className="w-20 rounded-lg bg-zinc-800 px-3 py-2 outline-none"
                />
                <span className="text-zinc-500 text-sm">min</span>
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={discussSeconds % 60}
                  onChange={(e) => {
                    const minutes = Math.floor(discussSeconds / 60);
                    const seconds = Number(e.target.value);
                    void saveDiscussSeconds(
                      minutes * 60 + (Number.isFinite(seconds) ? seconds : 0),
                    );
                  }}
                  className="w-20 rounded-lg bg-zinc-800 px-3 py-2 outline-none"
                />
                <span className="text-zinc-500 text-sm">sec</span>
              </div>
              <p className="text-zinc-500 text-xs">
                After each night, town talks for {formatClock(discussSeconds)}{" "}
                then votes.
              </p>
            </div>
          )}
          {me?.is_host && room.status === "lobby" && (
            <div className="rounded-xl bg-zinc-900 px-4 py-3 space-y-3">
              <p className="text-sm text-zinc-400">Roles in this game</p>
              <p className="flex items-center justify-between text-sm text-zinc-300">
                <span>Mafia</span>
                <span className="text-zinc-500 text-xs">always in</span>
              </p>
              {(
                [
                  ["includeDoctor", "Doctor", includeDoctor, (v: boolean) => saveLobbySettings({ include_doctor: v })],
                  ["includeDetective", "Detective", includeDetective, (v: boolean) => saveLobbySettings({ include_detective: v })],
                  ["includeJester", "Jester", includeJester, (v: boolean) => saveLobbySettings({ include_jester: v })],
                ] as const
              ).map(([key, label, on, set]) => (
                <label key={key} className="flex items-center justify-between text-sm">
                  <span>{label}</span>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => void set(e.target.checked)}
                    className="h-4 w-4 accent-red-600"
                  />
                </label>
              ))}
              <label className="flex items-center justify-between text-sm pt-1 border-t border-zinc-800">
                <span>Mafia can kill at night</span>
                <input
                  type="checkbox"
                  checked={mafiaCanKill}
                  onChange={(e) =>
                    void saveLobbySettings({ mafia_can_kill: e.target.checked })
                  }
                  className="h-4 w-4 accent-red-600"
                />
              </label>
            </div>
          )}
          {!me?.is_host && room.status === "lobby" && (
            <div className="text-center text-zinc-500 text-sm space-y-1">
              <p>
                Discussion after night:{" "}
                {formatClock(room.discuss_seconds ?? discussSeconds)}
              </p>
              <p>
                Roles:{" "}
                {[
                  "Mafia",
                  room.include_doctor !== false && "Doctor",
                  room.include_detective !== false && "Detective",
                  room.include_jester !== false && "Jester",
                  "Civilian",
                ]
                  .filter(Boolean)
                  .join(", ")}
              </p>
              <p>
                Mafia night kill:{" "}
                {room.mafia_can_kill === false ? "off" : "on"}
              </p>
            </div>
          )}
          <button
            type="button"
            onClick={startGame}
            disabled={!canStart || busy}
            className="press-btn press-btn-danger w-full rounded-xl bg-red-700 py-4 text-lg font-semibold disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            {me?.is_host
              ? canStart
                ? "Start game"
                : `Waiting for ${Math.max(0, 4 - players.length)} more`
              : room.status === "lobby"
                ? "Waiting for host"
                : "Dealing roles…"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (!room) return;
              void navigator.clipboard.writeText(room.code);
            }}
            className="press-btn w-full rounded-xl bg-zinc-900 py-3 text-sm"
          >
            Copy room code
          </button>
          <button
            type="button"
            onClick={leaveGame}
            disabled={busy}
            className="press-btn w-full rounded-xl bg-zinc-800 py-3 text-sm"
          >
            Leave game
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen text-zinc-50 flex items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-4xl text-center">Mafia</h1>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          className="w-full rounded-xl bg-zinc-900 px-4 py-3 outline-none"
        />
        <button
          type="button"
          onClick={createRoom}
          disabled={busy}
          className="press-btn press-btn-danger w-full rounded-xl bg-red-700 py-4 text-lg font-semibold disabled:opacity-50"
        >
          Create room
        </button>
        <div className="flex gap-2">
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="CODE"
            maxLength={6}
            className="flex-1 rounded-xl bg-zinc-900 px-4 py-3 outline-none tracking-widest"
          />
          <button
            type="button"
            onClick={joinRoom}
            disabled={busy}
            className="press-btn rounded-xl bg-zinc-800 px-4 py-3 font-semibold disabled:opacity-50"
          >
            Join
          </button>
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
      </div>
    </main>
  );
}

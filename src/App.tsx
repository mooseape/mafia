import { useEffect, useState } from "react";
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
};

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

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
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

  async function loadNote(roomId: string) {
    if (!myUserId) return;
    const { data: row } = await supabase
      .from("players")
      .select("id")
      .eq("room_id", roomId)
      .eq("user_id", myUserId)
      .single();
    if (!row) return;
    const { data } = await supabase
      .from("private_notes")
      .select("message")
      .eq("room_id", roomId)
      .eq("player_id", row.id)
      .order("night_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.message) setNote(data.message);
  }

  async function refreshRoom(roomId: string) {
    const { data } = await supabase
      .from("rooms")
      .select("*")
      .eq("id", roomId)
      .single();
    if (data) setRoom(data as Room);
  }

  useEffect(() => {
    if (!room) return;

    loadPlayers(room.id);
    loadLiving(room.id);
    if (myUserId) {
      loadMyRole(room.id, myUserId);
      loadNote(room.id);
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
            loadNote(room.id);
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
            loadNote(room.id);
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [room?.id, myUserId]);

  useEffect(() => {
    if (!room || !myUserId) return;
    if (room.status === "lobby") return;

    if (room.status === "night" || room.status === "reveal") {
      setPicked(null);
    }
    loadMyRole(room.id, myUserId);
    loadLiving(room.id);
    loadNote(room.id);

    const t = setInterval(() => {
      loadMyRole(room.id, myUserId);
      loadLiving(room.id);
      loadNote(room.id);
      refreshRoom(room.id);
    }, 1000);

    return () => clearInterval(t);
  }, [room?.id, room?.status, myUserId]);

  async function createRoom() {
    setError("");
    if (!name.trim()) {
      setError("Type a name first");
      return;
    }
    setBusy(true);
    try {
      const user = await ensureSignedIn();
      setMyUserId(user.id);
      const code = randomCode();
      const { data: newRoom, error: roomError } = await supabase
        .from("rooms")
        .insert({ code, host_id: user.id, status: "lobby" })
        .select()
        .single();
      if (roomError) throw roomError;
      const { error: playerError } = await supabase.from("players").insert({
        room_id: newRoom.id,
        user_id: user.id,
        name: name.trim(),
        is_host: true,
      });
      if (playerError) throw playerError;
      setRoom(newRoom as Room);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create room");
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom() {
    setError("");
    if (!name.trim()) {
      setError("Type a name first");
      return;
    }
    if (joinCode.trim().length < 4) {
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
      setRoom(found as Room);
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
      const { error } = await supabase.rpc("start_game", {
        p_room_id: room.id,
      });
      if (error) throw error;
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
      if (room) {
        await loadNote(room.id);
        await refreshRoom(room.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function goToVote() {
    setError("");
    setBusy(true);
    try {
      const { error } = await supabase.rpc("begin_day");
      if (error) throw error;
      setPicked(null);
      if (room) await refreshRoom(room.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start vote");
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
      setError(e instanceof Error ? e.message : "Vote failed");
    } finally {
      setBusy(false);
    }
  }

  if (room && room.status === "ended") {
    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-50 flex items-center justify-center p-6">
        <div className="w-full max-w-sm text-center space-y-4">
          <h1 className="text-4xl font-bold">Game over</h1>
          <p className="text-lg text-zinc-300">{room.announcement}</p>
          <p className="text-zinc-500">Winner: {room.winner ?? "unknown"}</p>
        </div>
      </main>
    );
  }

  if (room && room.status === "dawn") {
    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-50 flex items-center justify-center p-6">
        <div className="w-full max-w-sm text-center space-y-4">
          <h1 className="text-3xl font-bold">Morning</h1>
          <p className="text-lg text-zinc-300">
            {room.announcement ?? "The night is over."}
          </p>
          {note && <p className="text-amber-300">{note}</p>}
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="button"
            onClick={goToVote}
            disabled={busy}
            className="w-full rounded-xl bg-red-700 py-4 text-lg font-semibold"
          >
            Go to vote
          </button>
        </div>
      </main>
    );
  }

  if (room && room.status === "day") {
    const targets = living.filter((p) => p.is_alive && p.user_id !== myUserId);
    const amAlive = living.some((p) => p.user_id === myUserId && p.is_alive);

    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-50 p-6">
        <div className="mx-auto w-full max-w-sm space-y-4">
          <h1 className="text-center text-3xl font-bold">Day vote</h1>
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
                className="w-full rounded-xl bg-zinc-900 py-3"
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
        </div>
      </main>
    );
  }

  if (room && (room.status === "night" || room.status === "reveal") && myRole) {
    const info = ROLE_TEXT[myRole] ?? { title: myRole, blurb: "" };
    const canAct =
      myRole === "mafia" || myRole === "doctor" || myRole === "detective";
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
      <main className="min-h-screen bg-zinc-950 text-zinc-50 p-6">
        <div className="mx-auto w-full max-w-sm space-y-4">
          <p className="text-center text-zinc-500 text-sm">You are</p>
          <h1 className="text-center text-4xl font-bold">{info.title}</h1>
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
                  className="w-full rounded-xl bg-zinc-900 py-3"
                >
                  {p.name}
                  {p.user_id === myUserId ? " (you)" : ""}
                </button>
              ))}
            </div>
          )}

          {(!canAct || picked) && (
            <p className="text-center text-zinc-500">
              Waiting for the night to end…
            </p>
          )}

          {error && <p className="text-red-400 text-sm">{error}</p>}
        </div>
      </main>
    );
  }

  if (room) {
    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-50 p-6">
        <div className="mx-auto w-full max-w-sm space-y-6">
          <div className="text-center">
            <p className="text-zinc-400 text-sm">Room code</p>
            <p className="text-4xl font-bold tracking-[0.3em] mt-1">
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
          <button
            type="button"
            onClick={startGame}
            disabled={!canStart || busy}
            className="w-full rounded-xl bg-red-700 py-4 text-lg font-semibold disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            {me?.is_host
              ? canStart
                ? "Start game"
                : `Waiting for ${Math.max(0, 4 - players.length)} more`
              : room.status === "lobby"
                ? "Waiting for host"
                : "Dealing roles…"}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-50 flex items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-3xl font-bold text-center">Mafia</h1>
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
          className="w-full rounded-xl bg-red-700 py-4 text-lg font-semibold disabled:opacity-50"
        >
          Create room
        </button>
        <div className="flex gap-2">
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="CODE"
            className="flex-1 rounded-xl bg-zinc-900 px-4 py-3 outline-none tracking-widest"
          />
          <button
            type="button"
            onClick={joinRoom}
            disabled={busy}
            className="rounded-xl bg-zinc-800 px-4 font-semibold disabled:opacity-50"
          >
            Join
          </button>
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
      </div>
    </main>
  );
}

import Fastify from "fastify";
import cors from "@fastify/cors";
import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  CORS_ORIGIN: z.string().default("*"),
  GM_SECRET_PEPPER: z.string().min(16).default("CHANGE_ME_in_production_please"),
});

const env = envSchema.parse(process.env);

const fastify = Fastify({ logger: true });
await fastify.register(cors, {
  origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN.split(","),
  credentials: true,
});

fastify.get("/healthz", async () => ({ ok: true }));

/**
 * Socket.IOはNodeのhttp.Serverにぶら下げるのが簡単なので、
 * FastifyをhttpServerにマウントして共有する。
 */
const httpServer = createServer((req, res) => {
  fastify.server.emit("request", req, res);
});

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN.split(","),
    credentials: true,
  },
  transports: ["websocket", "polling"],
});

const joinRoomSchema = z.object({
  roomCode: z.string().min(6).max(32),
  displayName: z.string().min(1).max(32),
  gmSecret: z.string().min(8).max(256).optional(),
});

io.on("connection", (socket) => {
  socket.on("room:join", (raw, ack) => {
    const parsed = joinRoomSchema.safeParse(raw);
    if (!parsed.success) {
      ack?.({ ok: false, error: "invalid_payload", issues: parsed.error.issues });
      return;
    }

    const { roomCode, displayName, gmSecret } = parsed.data;
    socket.data.roomCode = roomCode;
    socket.data.displayName = displayName;
    socket.data.isGM = Boolean(gmSecret);

    socket.join(roomCode);
    ack?.({ ok: true, roomCode });

    socket.to(roomCode).emit("room:memberJoined", {
      displayName,
    });
  });

  socket.on("dice:roll", (raw, ack) => {
    const schema = z.object({
      sides: z.number().int().min(2).max(1000),
      count: z.number().int().min(1).max(100),
      visibility: z.enum(["public", "gm_only"]).default("public"),
    });

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      ack?.({ ok: false, error: "invalid_payload", issues: parsed.error.issues });
      return;
    }

    const roomCode = socket.data.roomCode as string | undefined;
    const displayName = socket.data.displayName as string | undefined;
    if (!roomCode || !displayName) {
      ack?.({ ok: false, error: "not_in_room" });
      return;
    }

    const { sides, count, visibility } = parsed.data;
    const results = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
    const total = results.reduce((a, b) => a + b, 0);

    const event = {
      displayName,
      sides,
      count,
      results,
      total,
      visibility,
      createdAt: new Date().toISOString(),
    };

    if (visibility === "public") {
      io.to(roomCode).emit("dice:rolled", event);
    } else {
      // GMのみ可視: まずは「GMが参加者端末のどれか」に依存せず、
      // 送信者がGM扱いの場合だけ全員へは出さない（MVP）。
      socket.emit("dice:rolled", event);
    }

    ack?.({ ok: true, total });
  });

  socket.on("effect:trigger", (raw, ack) => {
    const schema = z.object({
      kind: z.enum(["flash", "sound", "vibrate"]),
      target: z.enum(["all", "gm_only"]).default("all"),
      payload: z.unknown().optional(),
      gmSecret: z.string().optional(),
    });

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      ack?.({ ok: false, error: "invalid_payload", issues: parsed.error.issues });
      return;
    }

    const roomCode = socket.data.roomCode as string | undefined;
    if (!roomCode) {
      ack?.({ ok: false, error: "not_in_room" });
      return;
    }

    // MVP: GM判定は「gmSecretが来たか」だけ（後でハッシュ照合＆権限化）
    const isGM = Boolean(parsed.data.gmSecret) || Boolean(socket.data.isGM);
    if (!isGM) {
      ack?.({ ok: false, error: "forbidden" });
      return;
    }

    const event = {
      kind: parsed.data.kind,
      payload: parsed.data.payload ?? null,
      createdAt: new Date().toISOString(),
    };

    io.to(roomCode).emit("effect:triggered", event);
    ack?.({ ok: true });
  });
});

await fastify.ready();

httpServer.listen(env.PORT, "0.0.0.0", () => {
  fastify.log.info({ port: env.PORT }, "api listening");
});


//! Serveur HTTP/1.1 minimal sans dépendance : thread par connexion,
//! keep-alive non géré (Connection: close — Caddy gère les clients).
const std = @import("std");
const Io = std.Io;

pub const Method = enum { GET, POST, HEAD, other };

/// Petit spinlock (sections critiques très courtes : rendu JSON, swap d'arbre).
pub const SpinLock = struct {
    locked: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),

    pub fn lock(self: *SpinLock) void {
        while (self.locked.swap(true, .acquire)) {
            while (self.locked.load(.monotonic)) std.atomic.spinLoopHint();
        }
    }

    pub fn unlock(self: *SpinLock) void {
        _ = self.locked.store(false, .release);
    }
};

pub const Request = struct {
    method: Method,
    /// chemin sans query string
    path: []const u8,
    /// query string sans le '?' (peut être vide)
    query: []const u8,
    body: []const u8,
};

pub const Response = struct {
    status: u16 = 200,
    content_type: []const u8 = "application/json; charset=utf-8",
    body: []const u8 = "",
    headers: []const Header = &.{},
    /// si vrai, `body` est libéré par le serveur après envoi
    owned: bool = false,

    pub const Header = struct { name: []const u8, value: []const u8 };
};

pub const Handler = struct {
    ctx: *anyopaque,
    call: *const fn (ctx: *anyopaque, req: *const Request) anyerror!Response,
};

pub const Options = struct {
    /// Taille max du corps d'une requête (upload GED)
    max_body: usize = 64 * 1024 * 1024,
};

pub fn statusText(code: u16) []const u8 {
    return switch (code) {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        else => "OK",
    };
}

pub fn serve(gpa: std.mem.Allocator, io: Io, port: u16, handler: Handler, opts: Options) !void {
    const addr = try Io.net.IpAddress.parseIp4("0.0.0.0", port);
    std.log.info("bind 0.0.0.0:{d}", .{port});
    var server = try Io.net.IpAddress.listen(&addr, io, .{ .reuse_address = true });

    std.log.info("serveur en écoute sur 0.0.0.0:{d}", .{port});

    while (true) {
        const stream = server.accept(io) catch |err| {
            std.log.warn("accept: {s}", .{@errorName(err)});
            continue;
        };
        const t = std.Thread.spawn(.{ .stack_size = 1024 * 1024 }, handleConnection, .{ gpa, io, stream, handler, opts }) catch {
            stream.close(io);
            continue;
        };
        t.detach();
    }
}

fn handleConnection(gpa: std.mem.Allocator, io: Io, stream: Io.net.Stream, handler: Handler, opts: Options) void {
    defer stream.close(io);

    // ---- lecture des entêtes jusqu'à \r\n\r\n ----
    var head_buf: std.ArrayListUnmanaged(u8) = .empty;
    defer head_buf.deinit(gpa);

    var header_end: usize = 0;
    while (true) {
        if (head_buf.items.len > 64 * 1024) return; // entêtes démesurées
        var chunk: [8192]u8 = undefined;
        var bufs: [1][]u8 = .{chunk[0..]};
        const got = stream.read(io, &bufs) catch return;
        if (got == 0) return;
        head_buf.appendSlice(gpa, chunk[0..got]) catch return;
        if (std.mem.indexOf(u8, head_buf.items, "\r\n\r\n")) |idx| {
            header_end = idx + 4;
            break;
        }
    }

    const raw = head_buf.items;
    var req = (parseRequest(gpa, io, stream, raw[0..header_end], raw[header_end..], opts) catch |err| switch (err) {
        error.BadRequest => {
            respond(gpa, io, stream, .{ .status = 400, .body = "{\"error\":\"requête invalide\"}" }) catch {};
            return;
        },
        error.BodyTooLarge => {
            respond(gpa, io, stream, .{ .status = 413, .body = "{\"error\":\"fichier trop volumineux\"}" }) catch {};
            return;
        },
        else => return,
    }) orelse {
        respond(gpa, io, stream, .{ .status = 400, .body = "{\"error\":\"requête invalide\"}" }) catch {};
        return;
    };

    const res = handler.call(handler.ctx, &req) catch |err| blk: {
        std.log.warn("erreur handler {s} {s}: {s}", .{ @tagName(req.method), req.path, @errorName(err) });
        break :blk Response{ .status = 500, .body = "{\"error\":\"erreur interne\"}" };
    };
    if (req.body.len > 0) gpa.free(req.body);
    respond(gpa, io, stream, res) catch {};
    if (res.owned) gpa.free(res.body);
}

fn parseRequest(gpa: std.mem.Allocator, io: Io, stream: Io.net.Stream, head: []const u8, body_start: []const u8, opts: Options) !?Request {
    var lines = std.mem.splitSequence(u8, head, "\r\n");
    const first = lines.next() orelse return error.BadRequest;

    var parts = std.mem.splitScalar(u8, first, ' ');
    const method_str = parts.next() orelse return error.BadRequest;
    const target = parts.next() orelse return error.BadRequest;

    const method: Method = if (std.mem.eql(u8, method_str, "GET"))
        .GET
    else if (std.mem.eql(u8, method_str, "POST"))
        .POST
    else if (std.mem.eql(u8, method_str, "HEAD"))
        .HEAD
    else
        .other;

    var path = target;
    var query: []const u8 = "";
    if (std.mem.indexOfScalar(u8, target, '?')) |q| {
        path = target[0..q];
        query = target[q + 1 ..];
    }

    // Content-Length
    var content_length: usize = 0;
    while (lines.next()) |line| {
        if (line.len == 0) break;
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
        const name = std.mem.trim(u8, line[0..colon], " \t");
        if (std.ascii.eqlIgnoreCase(name, "Content-Length")) {
            const val = std.mem.trim(u8, line[colon + 1 ..], " \t");
            content_length = std.fmt.parseInt(usize, val, 10) catch return error.BadRequest;
        }
    }

    if (content_length > opts.max_body) return error.BodyTooLarge;

    if (content_length == 0) {
        return Request{ .method = method, .path = path, .query = query, .body = "" };
    }

    const body = try gpa.alloc(u8, content_length);
    errdefer gpa.free(body);
    const from_head = @min(body_start.len, content_length);
    @memcpy(body[0..from_head], body_start[0..from_head]);
    var have: usize = from_head;
    while (have < content_length) {
        var bufs: [1][]u8 = .{body[have..]};
        const got = stream.read(io, &bufs) catch return null;
        if (got == 0) return null;
        have += got;
    }

    return Request{ .method = method, .path = path, .query = query, .body = body };
}

fn respond(gpa: std.mem.Allocator, io: Io, stream: Io.net.Stream, res: Response) !void {
    var wbuf: [4096]u8 = undefined;
    var w = stream.writer(io, &wbuf);
    const iw = &w.interface;
    try iw.print("HTTP/1.1 {d} {s}\r\nContent-Type: {s}\r\nContent-Length: {d}\r\nConnection: close\r\n", .{
        res.status,
        statusText(res.status),
        res.content_type,
        res.body.len,
    });
    for (res.headers) |h| try iw.print("{s}: {s}\r\n", .{ h.name, h.value });
    try iw.writeAll("\r\n");
    try iw.writeAll(res.body);
    try iw.flush();
    _ = gpa;
}

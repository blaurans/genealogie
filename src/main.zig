const std = @import("std");
const http = @import("http.zig");
const gedcom = @import("gedcom.zig");
const json = @import("json.zig");
const assets = @import("assets.zig");

const State = struct {
    gpa: std.mem.Allocator,
    lock: http.SpinLock = .{},
    tree: ?*gedcom.Tree = null,
    data_dir: ?[]const u8 = null,
};

var state: State = undefined;

fn parseFile(data: []const u8, name: []const u8) !*gedcom.Tree {
    const t = try state.gpa.create(gedcom.Tree);
    errdefer state.gpa.destroy(t);
    t.* = try gedcom.parse(state.gpa, data, name);
    if (t.persons.len == 0) return error.NoPersons;
    return t;
}

fn persist(io: std.Io, data: []const u8) void {
    const dir = state.data_dir orelse return;
    var path_buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/current.ged", .{dir}) catch return;
    const f = std.Io.Dir.cwd().createFile(io, path, .{ .truncate = true }) catch |err| {
        std.log.warn("sauvegarde impossible ({s}): {s}", .{ path, @errorName(err) });
        return;
    };
    defer f.close(io);
    var buf: [8192]u8 = undefined;
    var w = f.writer(io, &buf);
    w.interface.writeAll(data) catch |err| {
        std.log.warn("écriture impossible: {s}", .{@errorName(err)});
    };
    w.interface.flush() catch {};
}

fn loadPersisted(io: std.Io) void {
    const dir = state.data_dir orelse return;
    var path_buf: [512]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/current.ged", .{dir}) catch return;
    const f = std.Io.Dir.cwd().openFile(io, path, .{}) catch return;
    defer f.close(io);

    var rbuf: [8192]u8 = undefined;
    var r = f.readerStreaming(io, &rbuf);
    const data = r.interface.allocRemaining(state.gpa, .limited(64 * 1024 * 1024)) catch return;
    defer state.gpa.free(data);

    const t = parseFile(data, "current.ged") catch return;
    state.tree = t;
    std.log.info("données précédentes rechargées: {s} ({d} personnes)", .{ t.file_name, t.persons.len });
}

/// Nom de fichier envoyé en query ?name=..., décodé et nettoyé.
fn fileNameFromQuery(query: []const u8, buf: []u8) []const u8 {
    var it = std.mem.splitScalar(u8, query, '&');
    while (it.next()) |pair| {
        const eq = std.mem.indexOfScalar(u8, pair, '=') orelse continue;
        if (!std.mem.eql(u8, pair[0..eq], "name")) continue;
        const val = pair[eq + 1 ..];
        var out: usize = 0;
        var i: usize = 0;
        while (i < val.len and out < buf.len - 1) : (i += 1) {
            if (val[i] == '%' and i + 2 < val.len) {
                const hex = std.fmt.parseInt(u8, val[i + 1 .. i + 3], 16) catch {
                    buf[out] = val[i];
                    out += 1;
                    continue;
                };
                buf[out] = hex;
                out += 1;
                i += 2;
            } else {
                buf[out] = val[i];
                out += 1;
            }
        }
        var name = buf[0..out];
        if (std.mem.lastIndexOfScalar(u8, name, '/')) |s| name = name[s + 1 ..];
        if (std.mem.lastIndexOfScalar(u8, name, '\\')) |s| name = name[s + 1 ..];
        if (name.len > 80) name = name[0..80];
        return name;
    }
    return "import.ged";
}

fn handler(ctx: *anyopaque, req: *const http.Request) anyerror!http.Response {
    const s: *State = @ptrCast(@alignCast(ctx));
    const io = request_io;

    if (req.method == .GET) {
        if (std.mem.eql(u8, req.path, "/") or std.mem.eql(u8, req.path, "/index.html"))
            return .{ .content_type = "text/html; charset=utf-8", .body = assets.index_html };
        if (std.mem.eql(u8, req.path, "/style.css"))
            return .{ .content_type = "text/css; charset=utf-8", .body = assets.style_css };
        if (std.mem.eql(u8, req.path, "/app.js"))
            return .{ .content_type = "text/javascript; charset=utf-8", .body = assets.app_js };
        if (std.mem.eql(u8, req.path, "/demo.ged"))
            return .{ .content_type = "text/plain; charset=utf-8", .body = assets.demo_ged };
        if (std.mem.eql(u8, req.path, "/api/data")) {
            s.lock.lock();
            defer s.lock.unlock();
            const t = s.tree orelse return .{ .owned = true, .body = try json.emptyPayload(s.gpa) };
            return .{ .owned = true, .body = try json.renderTree(s.gpa, t) };
        }
        if (std.mem.eql(u8, req.path, "/healthz"))
            return .{ .content_type = "text/plain; charset=utf-8", .body = "ok" };
    }

    if (req.method == .POST and std.mem.eql(u8, req.path, "/api/upload")) {
        var name_buf: [128]u8 = undefined;
        const fname = fileNameFromQuery(req.query, &name_buf);

        const t = parseFile(req.body, fname) catch |err| {
            const msg: []const u8 = switch (err) {
                error.NoPersons => "aucune personne (INDI) trouvée dans le fichier",
                error.OutOfMemory => "fichier trop volumineux",
            };
            var buf: [256]u8 = undefined;
            const body = std.fmt.bufPrint(&buf, "{{\"error\":\"{s}\"}}", .{msg}) catch "{\"error\":\"erreur\"}";
            return .{ .status = 400, .body = body };
        };

        persist(io, req.body);

        s.lock.lock();
        if (s.tree) |old| old.deinit();
        s.tree = t;
        s.lock.unlock();

        std.log.info("GEDCOM chargé: {s} ({d} personnes, {d} familles)", .{ t.file_name, t.persons.len, t.families.len });

        s.lock.lock();
        defer s.lock.unlock();
        return .{ .owned = true, .body = try json.renderTree(s.gpa, t) };
    }

    return .{ .status = 404, .body = "{\"error\":\"non trouvé\"}" };
}

/// Le handler n'a pas d'accès io par paramètre — on stocke le handle global ici.
var request_io: std.Io = undefined;

pub fn main() !void {
    var threaded = std.Io.Threaded.init(std.heap.smp_allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();
    request_io = io;

    state = State{ .gpa = std.heap.smp_allocator };

    var port: u16 = 8080;
    var port_buf: [64]u8 = undefined;
    var data_dir_buf: [512]u8 = undefined;

    if (getEnv(io, "PORT", &port_buf)) |p| {
        port = std.fmt.parseInt(u16, p, 10) catch port;
    }
    if (getEnv(io, "DATA_DIR", &data_dir_buf)) |d| {
        state.data_dir = d;
    }

    loadPersisted(io);
    try http.serve(state.gpa, io, port, .{ .ctx = &state, .call = handler }, .{});
}

/// Lecture d'une variable d'environnement via /proc/self/environ
/// (indépendant des changements d'API process entre versions).
/// La valeur est copiée dans `buf` pour rester valide après le retour.
fn getEnv(io: std.Io, name: []const u8, buf: []u8) ?[]const u8 {
    const f = std.Io.Dir.openFileAbsolute(io, "/proc/self/environ", .{}) catch return null;
    defer f.close(io);
    var rbuf: [8192]u8 = undefined;
    var r = f.readerStreaming(io, &rbuf);
    const data = r.interface.allocRemaining(state.gpa, .limited(1024 * 1024)) catch return null;
    defer state.gpa.free(data);
    var it = std.mem.splitScalar(u8, data, 0);
    while (it.next()) |entry| {
        const eq = std.mem.indexOfScalar(u8, entry, '=') orelse continue;
        if (std.mem.eql(u8, entry[0..eq], name)) {
            const val = entry[eq + 1 ..];
            if (val.len >= buf.len) return null;
            @memcpy(buf[0..val.len], val);
            return buf[0..val.len];
        }
    }
    return null;
}

//! Sérialisation JSON manuelle (sans dépendre de l'API std.json qui bouge
//! entre versions) — sortie consommée par le front-end.
const std = @import("std");
const gedcom = @import("gedcom.zig");
const Allocator = std.mem.Allocator;

/// Échappe une chaîne pour JSON, contrôle chars inclus.
fn writeEscaped(out: *std.ArrayListUnmanaged(u8), alloc: Allocator, s: []const u8) !void {
    for (s) |c| {
        switch (c) {
            '"' => try out.appendSlice(alloc, "\\\""),
            '\\' => try out.appendSlice(alloc, "\\\\"),
            '\n' => try out.appendSlice(alloc, "\\n"),
            '\r' => try out.appendSlice(alloc, "\\r"),
            '\t' => try out.appendSlice(alloc, "\\t"),
            else => {
                if (c < 0x20) {
                    var buf: [8]u8 = undefined;
                    const t = std.fmt.bufPrint(&buf, "\\u{x:0>4}", .{c}) catch unreachable;
                    try out.appendSlice(alloc, t);
                } else {
                    try out.append(alloc, c);
                }
            },
        }
    }
}

fn writeStr(out: *std.ArrayListUnmanaged(u8), alloc: Allocator, s: []const u8) !void {
    try out.append(alloc, '"');
    try writeEscaped(out, alloc, s);
    try out.append(alloc, '"');
}

fn writeMaybeStr(out: *std.ArrayListUnmanaged(u8), alloc: Allocator, s: ?[]const u8) !void {
    if (s) |v| {
        try writeStr(out, alloc, v);
    } else {
        try out.appendSlice(alloc, "null");
    }
}

/// JSON quand aucun fichier n'est chargé.
pub fn emptyPayload(alloc: Allocator) ![]u8 {
    return alloc.dupe(u8,
        \\{"loaded":false,"file":"","count":0,"persons":[],"families":[]}
    );
}

/// Rend tout l'arbre en JSON : {loaded, file, count, persons[], families[]}.
pub fn renderTree(alloc: Allocator, tree: *const gedcom.Tree) ![]u8 {
    var out: std.ArrayListUnmanaged(u8) = .empty;
    errdefer out.deinit(alloc);

    try out.appendSlice(alloc, "{\"loaded\":true,\"file\":");
    try writeStr(&out, alloc, tree.file_name);
    try out.print(alloc, ",\"count\":{d},\"persons\":[", .{tree.persons.len});

    var buf: [512]u8 = undefined;
    for (tree.persons, 0..) |*p, i| {
        if (i > 0) try out.append(alloc, ',');
        try out.appendSlice(alloc, "{\"id\":");
        try writeStr(&out, alloc, p.id);
        try out.appendSlice(alloc, ",\"name\":");
        try writeStr(&out, alloc, gedcom.fullName(p, &buf));
        try out.appendSlice(alloc, ",\"given\":");
        try writeStr(&out, alloc, p.given);
        try out.appendSlice(alloc, ",\"surname\":");
        try writeStr(&out, alloc, p.surname);
        try out.appendSlice(alloc, ",\"sex\":");
        try writeStr(&out, alloc, p.sex.letter());
        try out.appendSlice(alloc, ",\"birth\":");
        try writeStr(&out, alloc, p.birth_date);
        try out.appendSlice(alloc, ",\"birthPlace\":");
        try writeStr(&out, alloc, p.birth_place);
        try out.appendSlice(alloc, ",\"death\":");
        try writeStr(&out, alloc, p.death_date);
        try out.appendSlice(alloc, ",\"deathPlace\":");
        try writeStr(&out, alloc, p.death_place);
        try out.appendSlice(alloc, ",\"famc\":");
        try writeMaybeStr(&out, alloc, p.famc);
        try out.appendSlice(alloc, ",\"fams\":[");
        for (p.fams.items, 0..) |fx, j| {
            if (j > 0) try out.append(alloc, ',');
            try writeStr(&out, alloc, fx);
        }
        try out.appendSlice(alloc, "]}");
    }

    try out.appendSlice(alloc, "],\"families\":[");
    for (tree.families, 0..) |*f, i| {
        if (i > 0) try out.append(alloc, ',');
        try out.appendSlice(alloc, "{\"id\":");
        try writeStr(&out, alloc, f.id);
        try out.appendSlice(alloc, ",\"husb\":");
        try writeMaybeStr(&out, alloc, f.husb);
        try out.appendSlice(alloc, ",\"wife\":");
        try writeMaybeStr(&out, alloc, f.wife);
        try out.appendSlice(alloc, ",\"children\":[");
        for (f.children.items, 0..) |cx, j| {
            if (j > 0) try out.append(alloc, ',');
            try writeStr(&out, alloc, cx);
        }
        try out.appendSlice(alloc, "],\"marriage\":");
        try writeStr(&out, alloc, f.marriage_date);
        try out.appendSlice(alloc, ",\"marriagePlace\":");
        try writeStr(&out, alloc, f.marriage_place);
        try out.appendSlice(alloc, "}");
    }

    try out.appendSlice(alloc, "]}");
    return out.toOwnedSlice(alloc);
}

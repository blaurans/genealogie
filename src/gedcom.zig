//! Parseur GEDCOM 5.5 minimal : INDI (nom, sexe, naissance, décès, FAMC/FAMS)
//! et FAM (époux, épouse, enfants, mariage). Rend une structure exploitable
//! directement pour la sérialisation JSON côté serveur.
const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Sex = enum {
    unknown,
    male,
    female,

    pub fn letter(self: Sex) []const u8 {
        return switch (self) {
            .male => "M",
            .female => "F",
            .unknown => "U",
        };
    }
};

pub const Person = struct {
    id: []const u8,
    given: []const u8 = "",
    surname: []const u8 = "",
    sex: Sex = .unknown,
    birth_date: []const u8 = "",
    birth_place: []const u8 = "",
    death_date: []const u8 = "",
    death_place: []const u8 = "",
    /// xref de la famille où la personne est enfant (sans les @)
    famc: ?[]const u8 = null,
    /// xrefs des familles où la personne est conjoint
    fams: std.ArrayListUnmanaged([]const u8) = .empty,
};

pub const Family = struct {
    id: []const u8,
    husb: ?[]const u8 = null,
    wife: ?[]const u8 = null,
    children: std.ArrayListUnmanaged([]const u8) = .empty,
    marriage_date: []const u8 = "",
    marriage_place: []const u8 = "",
};

/// Arbre généalogique complet, mémoire possédée par `arena`.
pub const Tree = struct {
    arena: std.heap.ArenaAllocator,
    persons: []Person = &.{},
    families: []Family = &.{},
    /// xref → index dans `persons`
    pindex: std.StringHashMapUnmanaged(usize) = .empty,
    /// xref → index dans `families`
    findex: std.StringHashMapUnmanaged(usize) = .empty,
    file_name: []const u8 = "",

    pub fn deinit(self: *Tree) void {
        self.arena.deinit();
    }

    pub fn personById(self: *const Tree, xref: []const u8) ?*const Person {
        const i = self.pindex.get(xref) orelse return null;
        return &self.persons[i];
    }

    pub fn familyById(self: *const Tree, xref: []const u8) ?*const Family {
        const i = self.findex.get(xref) orelse return null;
        return &self.families[i];
    }
};

pub fn fullName(p: *const Person, buf: []u8) []const u8 {
    if (p.surname.len == 0) return p.given;
    if (p.given.len == 0) return p.surname;
    return std.fmt.bufPrint(buf, "{s} {s}", .{ p.given, p.surname }) catch p.given;
}

const Parser = struct {
    arena: Allocator,
    persons: std.ArrayListUnmanaged(Person) = .empty,
    families: std.ArrayListUnmanaged(Family) = .empty,
    file_name: []const u8,

    fn concat(self: *Parser, base: []const u8, add: []const u8) ![]const u8 {
        if (base.len == 0) return add;
        if (add.len == 0) return base;
        return std.mem.concat(self.arena, u8, &.{ base, " ", add });
    }

    fn finalizePerson(self: *Parser, p: *Person) !void {
        if (p.id.len == 0) return;
        try self.persons.append(self.arena, p.*);
    }

    fn finalizeFamily(self: *Parser, f: *Family) !void {
        if (f.id.len == 0) return;
        try self.families.append(self.arena, f.*);
    }
};

const Line = struct {
    level: u16,
    xref: ?[]const u8,
    tag: []const u8,
    value: []const u8,
};

/// Découpe une ligne GEDCOM : `Niveau [@XREF@] TAG [valeur]`.
fn parseLine(line_in: []const u8) ?Line {
    var line = std.mem.trim(u8, line_in, " \t\r\n");
    if (line.len == 0) return null;

    // Niveau
    var i: usize = 0;
    while (i < line.len and line[i] >= '0' and line[i] <= '9') i += 1;
    if (i == 0) return null;
    const level = std.fmt.parseInt(u16, line[0..i], 10) catch return null;
    line = std.mem.trimStart(u8, line[i..], " \t");

    // [@XREF@]
    var xref: ?[]const u8 = null;
    if (line.len > 0 and line[0] == '@') {
        const end = std.mem.indexOfScalarPos(u8, line, 1, '@') orelse return null;
        xref = line[1..end];
        line = std.mem.trimStart(u8, line[end + 1 ..], " \t");
    }

    // TAG
    i = 0;
    while (i < line.len and line[i] != ' ' and line[i] != '\t') i += 1;
    const tag = line[0..i];
    if (tag.len == 0) return null;
    const value = std.mem.trim(u8, line[i..], " \t");

    return .{ .level = level, .xref = xref, .tag = tag, .value = value };
}

/// Extrait prénom / nom d'une valeur NAME : "Prénom /Nom/ suffixe".
fn parseName(p: *Parser, pers: *Person, value: []const u8) !void {
    if (std.mem.indexOf(u8, value, "/")) |start| {
        pers.given = std.mem.trim(u8, value[0..start], " ");
        const rest = value[start + 1 ..];
        if (std.mem.indexOfScalar(u8, rest, '/')) |end| {
            pers.surname = std.mem.trim(u8, rest[0..end], " ");
            const suffix = std.mem.trim(u8, rest[end + 1 ..], " ");
            if (suffix.len > 0) pers.surname = try p.concat(pers.surname, suffix);
        } else {
            pers.surname = std.mem.trim(u8, rest, " ");
        }
    } else {
        pers.given = value;
    }
}

/// Parse un buffer GEDCOM complet. Copie tout dans un arena ; `input` n'est
/// plus référencé après le retour.
pub fn parse(parent_alloc: Allocator, input: []const u8, file_name: []const u8) !Tree {
    var arena = std.heap.ArenaAllocator.init(parent_alloc);
    errdefer arena.deinit();
    const a = arena.allocator();

    var p = Parser{ .arena = a, .file_name = try a.dupe(u8, file_name) };

    // Contournement : la source peut contenir un BOM UTF-8.
    var src = input;
    if (std.mem.startsWith(u8, src, "\xEF\xBB\xBF")) src = src[3..];

    var cur: enum { none, indi, fam } = .none;
    var person: Person = undefined;
    var family: Family = undefined;
    var ctx: enum { none, name, birth, death, marriage } = .none;

    var iter = std.mem.splitScalar(u8, src, '\n');
    while (iter.next()) |raw| {
        const ln = parseLine(raw) orelse continue;

        if (ln.level == 0) {
            switch (cur) {
                .indi => try p.finalizePerson(&person),
                .fam => try p.finalizeFamily(&family),
                .none => {},
            }
            cur = .none;
            ctx = .none;
            if (ln.xref) |xr| {
                if (std.ascii.eqlIgnoreCase(ln.tag, "INDI")) {
                    person = .{ .id = try a.dupe(u8, xr) };
                    cur = .indi;
                } else if (std.ascii.eqlIgnoreCase(ln.tag, "FAM")) {
                    family = .{ .id = try a.dupe(u8, xr) };
                    cur = .fam;
                }
            }
            continue;
        }

        switch (cur) {
            .none => {},
            .indi => {
                const t = ln.tag;
                if (std.ascii.eqlIgnoreCase(t, "NAME")) {
                    try parseName(&p, &person, ln.value);
                    ctx = .name;
                } else if (std.ascii.eqlIgnoreCase(t, "GIVN")) {
                    if (ln.value.len > 0) person.given = ln.value;
                } else if (std.ascii.eqlIgnoreCase(t, "SURN")) {
                    if (ln.value.len > 0) person.surname = ln.value;
                } else if (std.ascii.eqlIgnoreCase(t, "SEX")) {
                    person.sex = if (ln.value.len > 0 and (ln.value[0] == 'M' or ln.value[0] == 'm'))
                        .male
                    else if (ln.value.len > 0 and (ln.value[0] == 'F' or ln.value[0] == 'f'))
                        .female
                    else
                        .unknown;
                } else if (std.ascii.eqlIgnoreCase(t, "BIRT")) {
                    ctx = .birth;
                } else if (std.ascii.eqlIgnoreCase(t, "DEAT")) {
                    ctx = .death;
                } else if (std.ascii.eqlIgnoreCase(t, "FAMC")) {
                    if (ln.xref == null and ln.value.len > 0 and ln.value[0] == '@') {
                        // variante FAMC @F1@
                        if (std.mem.indexOfScalarPos(u8, ln.value, 1, '@')) |e|
                            person.famc = ln.value[1..e];
                    } else if (ln.xref) |xr| {
                        person.famc = xr;
                    }
                } else if (std.ascii.eqlIgnoreCase(t, "FAMS")) {
                    if (ln.xref) |xr| {
                        try person.fams.append(a, xr);
                    } else if (ln.value.len > 1 and ln.value[0] == '@') {
                        if (std.mem.indexOfScalarPos(u8, ln.value, 1, '@')) |e|
                            try person.fams.append(a, ln.value[1..e]);
                    }
                } else if (std.ascii.eqlIgnoreCase(t, "DATE")) {
                    switch (ctx) {
                        .birth => person.birth_date = ln.value,
                        .death => person.death_date = ln.value,
                        else => {},
                    }
                } else if (std.ascii.eqlIgnoreCase(t, "PLAC")) {
                    switch (ctx) {
                        .birth => person.birth_place = ln.value,
                        .death => person.death_place = ln.value,
                        else => {},
                    }
                } else if (std.ascii.eqlIgnoreCase(t, "CONT")) {
                    if (ctx == .name) {
                        person.given = try p.concat(person.given, ln.value);
                    }
                } else if (std.ascii.eqlIgnoreCase(t, "CONC")) {
                    if (ctx == .name) {
                        person.given = try std.mem.concat(a, u8, &.{ person.given, ln.value });
                    }
                } else {
                    ctx = .none;
                }
            },
            .fam => {
                const t = ln.tag;
                if (std.ascii.eqlIgnoreCase(t, "HUSB")) {
                    family.husb = if (ln.xref) |xr| xr else extractRef(ln.value);
                } else if (std.ascii.eqlIgnoreCase(t, "WIFE")) {
                    family.wife = if (ln.xref) |xr| xr else extractRef(ln.value);
                } else if (std.ascii.eqlIgnoreCase(t, "CHIL")) {
                    const r = if (ln.xref) |xr| xr else extractRef(ln.value);
                    if (r) |rr| try family.children.append(a, rr);
                } else if (std.ascii.eqlIgnoreCase(t, "MARR")) {
                    ctx = .marriage;
                } else if (std.ascii.eqlIgnoreCase(t, "DATE")) {
                    if (ctx == .marriage) family.marriage_date = ln.value;
                } else if (std.ascii.eqlIgnoreCase(t, "PLAC")) {
                    if (ctx == .marriage) family.marriage_place = ln.value;
                } else if (!std.ascii.eqlIgnoreCase(t, "CONT") and
                    !std.ascii.eqlIgnoreCase(t, "CONC"))
                {
                    ctx = .none;
                }
            },
        }
    }
    switch (cur) {
        .indi => try p.finalizePerson(&person),
        .fam => try p.finalizeFamily(&family),
        .none => {},
    }

    var tree = Tree{
        .arena = arena,
        .file_name = p.file_name,
    };
    tree.persons = try p.persons.toOwnedSlice(a);
    tree.families = try p.families.toOwnedSlice(a);

    // Toutes les valeurs pointent potentiellement dans `input` (libéré après
    // le parse) : on les recopie dans l'arena.
    for (tree.persons) |*pers| {
        pers.given = try a.dupe(u8, pers.given);
        pers.surname = try a.dupe(u8, pers.surname);
        pers.birth_date = try a.dupe(u8, pers.birth_date);
        pers.birth_place = try a.dupe(u8, pers.birth_place);
        pers.death_date = try a.dupe(u8, pers.death_date);
        pers.death_place = try a.dupe(u8, pers.death_place);
        if (pers.famc) |famc| pers.famc = try a.dupe(u8, famc);
        for (pers.fams.items) |*fx| fx.* = try a.dupe(u8, fx.*);
    }
    for (tree.families) |*fam| {
        if (fam.husb) |h| fam.husb = try a.dupe(u8, h);
        if (fam.wife) |w| fam.wife = try a.dupe(u8, w);
        for (fam.children.items) |*cx| cx.* = try a.dupe(u8, cx.*);
        fam.marriage_date = try a.dupe(u8, fam.marriage_date);
        fam.marriage_place = try a.dupe(u8, fam.marriage_place);
    }

    for (tree.persons, 0..) |*pers, i| try tree.pindex.put(a, pers.id, i);
    for (tree.families, 0..) |*fam, i| try tree.findex.put(a, fam.id, i);
    return tree;
}

fn extractRef(value: []const u8) ?[]const u8 {
    if (value.len >= 2 and value[0] == '@') {
        if (std.mem.indexOfScalarPos(u8, value, 1, '@')) |e| return value[1..e];
    }
    return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testing = std.testing;

const sample_ged =
    "0 HEAD\n" ++
    "1 SOUR test\n" ++
    "0 @I1@ INDI\n" ++
    "1 NAME Jean /Dupont/\n" ++
    "1 SEX M\n" ++
    "1 BIRT\n" ++
    "2 DATE 12 MAI 1945\n" ++
    "2 PLAC Lyon, France\n" ++
    "1 FAMS @F1@\n" ++
    "0 @I2@ INDI\n" ++
    "1 NAME Marie /Martin/\n" ++
    "1 SEX F\n" ++
    "1 FAMS @F1@\n" ++
    "0 @I3@ INDI\n" ++
    "1 NAME Pierre /Dupont/\n" ++
    "1 SEX M\n" ++
    "1 BIRT\n" ++
    "2 DATE 3 JUN 1970\n" ++
    "1 FAMC @F1@\n" ++
    "1 FAMS @F2@\n" ++
    "0 @I4@ INDI\n" ++
    "1 NAME Anne /Durand/ de la Roche\n" ++
    "1 FAMS @F2@\n" ++
    "0 @F1@ FAM\n" ++
    "1 HUSB @I1@\n" ++
    "1 WIFE @I2@\n" ++
    "1 CHIL @I3@\n" ++
    "1 MARR\n" ++
    "2 DATE 20 SEP 1968\n" ++
    "2 PLAC Paris\n" ++
    "0 @F2@ FAM\n" ++
    "1 HUSB @I3@\n" ++
    "1 WIFE @I4@\n" ++
    "0 TRLR\n";

test "parse basic gedcom" {
    var tree = try parse(std.heap.page_allocator, sample_ged, "test.ged");
    defer tree.deinit();

    try testing.expectEqual(@as(usize, 4), tree.persons.len);
    try testing.expectEqual(@as(usize, 2), tree.families.len);

    const jean = tree.personById("I1").?;
    try testing.expectEqualStrings("Jean", jean.given);
    try testing.expectEqualStrings("Dupont", jean.surname);
    try testing.expectEqual(Sex.male, jean.sex);
    try testing.expectEqualStrings("12 MAI 1945", jean.birth_date);
    try testing.expectEqualStrings("Lyon, France", jean.birth_place);
    try testing.expectEqualStrings("F1", jean.fams.items[0]);

    const pierre = tree.personById("I3").?;
    try testing.expectEqualStrings("F1", pierre.famc.?);
    try testing.expectEqualStrings("F2", pierre.fams.items[0]);

    const anne = tree.personById("I4").?;
    try testing.expectEqualStrings("Durand de la Roche", anne.surname);

    const f1 = tree.familyById("F1").?;
    try testing.expectEqualStrings("I1", f1.husb.?);
    try testing.expectEqualStrings("I2", f1.wife.?);
    try testing.expectEqual(@as(usize, 1), f1.children.items.len);
    try testing.expectEqualStrings("20 SEP 1968", f1.marriage_date);
}

test "strings survive input deallocation" {
    // page_allocator : évite le faux positif de fuite du SafeAllocator de test
    // avec les gros buffers d'arena.
    const alloc = std.heap.page_allocator;
    const input = try testing.allocator.dupe(u8, sample_ged);
    defer testing.allocator.free(input);
    var tree = try parse(alloc, input, "test.ged");
    defer tree.deinit();
    // l'entrée est libérée ci-dessus : les champs doivent rester valides
    const jean = tree.personById("I1").?;
    try testing.expectEqualStrings("Jean", jean.given);
    try testing.expectEqualStrings("Dupont", jean.surname);
    try testing.expectEqualStrings("12 MAI 1945", jean.birth_date);
    const f1 = tree.familyById("F1").?;
    try testing.expectEqualStrings("20 SEP 1968", f1.marriage_date);
}

test "empty input" {
    var tree = try parse(testing.allocator, "", "empty.ged");
    defer tree.deinit();
    try testing.expectEqual(@as(usize, 0), tree.persons.len);
}

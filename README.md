# genealogie

Visualiseur d'arbre généalogique : importez un fichier GEDCOM (`.ged`),
explorez ancêtres, descendants, unions, dates et lieux sur un arbre
interactif (pan/zoom, recherche, fiches détaillées).

Le serveur est écrit en **Zig** (aucune dépendance : HTTP maison sur
`std.Io.net`, parseur GEDCOM dédié, assets embarqués dans le binaire).

## Fonctionnalités

- Import d'un fichier `.ged` depuis le navigateur (persisté dans `/data`,
  rechargé au démarrage du serveur)
- Arbre interactif : ancêtres au-dessus, descendants en dessous, conjoints
  côte à côte, molette pour zoomer, clic-glisser pour se déplacer
- Nombre de générations affichées réglable (1 à 8)
- Recherche instantanée (nom, lieux), clic pour recentrer l'arbre
- Fiche détaillée par personne : naissance/décès, parents, unions, enfants
  (tous cliquables)
- Exemple de démonstration intégré (`/demo.ged`)

## Utilisation

```sh
zig build run            # développement (PORT par défaut : 8080)
zig build test           # tests du parseur GEDCOM
docker compose up -d --build   # production
```

Variables : `PORT` (défaut 8080), `DATA_DIR` (si défini, le dernier fichier
importé est persisté dans `$DATA_DIR/current.ged` et rechargé au démarrage).

## API

| Route | Description |
|---|---|
| `GET /` | interface web |
| `GET /api/data` | arbre courant en JSON |
| `POST /api/upload?name=fichier.ged` | corps = contenu GEDCOM brut |
| `GET /demo.ged` | fichier d'exemple |
| `GET /healthz` | sonde de vie |

## Docker + Caddy

Le compose joint le réseau Docker `headscale_default` (là où tourne le
Caddy d'ociuc). Dans le `Caddyfile` :

```
genealogie.laurans.org {
	reverse_proxy genealogie:8080
}
```

Puis `docker exec caddy caddy reload --config /etc/caddy/Caddyfile`.

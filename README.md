# TPE Site Data

This repository is the data backend for **The Performance Ecosystem** site.  
All content is stored as plain JSON files under `/data/`. The site reads them
directly from GitHub's raw CDN and writes back via the GitHub Contents API.

---

## Repository structure

```
tpe-data/
└── data/
    ├── vendors.json        ← Vendor/technology directory
    ├── news.json           ← News articles
    ├── events.json         ← Conferences & events
    ├── jobs.json           ← Job listings
    ├── clubs.json          ← Sports clubs
    ├── club_people.json    ← People at clubs (staff, practitioners)
    ├── practitioners.json  ← Standalone practitioners
    ├── club_vendors.json   ← Club ↔ Vendor links (junction)
    └── admin_users.json    ← Admin accounts (password in plain text — keep repo PRIVATE or rotate regularly)
```

---

## How reads work

Every page fetches data from the GitHub raw CDN:

```
https://raw.githubusercontent.com/OWNER/REPO/main/data/TABLE.json
```

A cache-busting `?t=TIMESTAMP` query param is appended so admins see fresh
data immediately after a write. The TTL cache in localStorage means regular
visitors only hit the CDN once per cache window (10–30 min depending on dataset).

## How writes work (admin only)

Admin saves use the **GitHub Contents API**:

1. `GET /repos/OWNER/REPO/contents/data/TABLE.json` → get current blob SHA  
2. `PUT /repos/OWNER/REPO/contents/data/TABLE.json` → write updated JSON + SHA

This requires a Personal Access Token (PAT) stored in `tpe-data.js`.

---

## Initial setup

### 1 — Create the repo

Create a new GitHub repository (e.g. `tpe-data`).  
**Public** is recommended — reads are faster via the CDN and no auth is needed for reads.  
If `admin_users.json` needs to stay private, use a **private** repo instead
(reads will then go through the API with the token, which is slightly slower).

### 2 — Upload the seed files

Upload every file in the `/data/` folder from this package into the root of
the new repo under a `data/` folder.  You can use the GitHub web UI:
- Click **Add file → Upload files**
- Drag all nine `.json` files in, set the target path to `data/`
- Commit with message `Initial seed data`

### 3 — Create a Personal Access Token

Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**

| Setting | Value |
|---|---|
| Token name | `tpe-data-write` |
| Expiration | 1 year (or no expiry) |
| Repository access | Only `tpe-data` |
| Permissions → Contents | **Read and write** |

Copy the generated token (`ghp_...`).

### 4 — Configure tpe-data.js

Open `tpe-data.js` and fill in the three config variables at the top:

```js
var GH_OWNER  = 'your-github-username';
var GH_REPO   = 'tpe-data';
var GH_TOKEN  = 'ghp_your_token_here';
```

Deploy the updated `tpe-data.js` alongside the site HTML files.

### 5 — Migrate existing Supabase data (optional)

If you have live data in Supabase, export each table as JSON from the
Supabase dashboard (**Table Editor → … → Export as JSON**), then upload
the files to `data/TABLE.json` in this repo, replacing the empty seed files.

---

## Data schema reference

### vendors.json
Each record is an object with these fields (all optional except `id` and `name`):

| Field | Type | Notes |
|---|---|---|
| id | string (UUID) | Auto-generated on create |
| name | string | Required |
| website | string | |
| tech | string | Technology descriptor |
| sport | string | Default: `MultiSports` |
| categories | string[] | |
| synopsis | string | Short description |
| synopsis_long | string | Full description |
| logo_url | string | |
| is_active | boolean | Default: `true` |
| is_featured | boolean | |
| is_new | boolean | |
| is_archived | boolean | |
| show_in_gallery | boolean | |
| scores | object | `{value, speed, support, ...}` |
| tags | string[] | |
| social | object[] | `[{platform, url}]` |
| key_personnel | object[] | `[{name, role, linkedin}]` |
| created_at | ISO date string | Auto-set |
| updated_at | ISO date string | Auto-updated |

### news.json
`id, headline, summary, url, source, date (YYYY-MM-DD), image_url, tags[], departments[], vendors[], featured, is_new, is_archived, show_in_gallery`

### events.json
`id, title, type, url, date_start, date_end, location, country, synopsis, description, logo_url, organiser, sponsor, sponsors[], ticket_types[], tags[], departments[], is_featured, is_new, is_archived, show_in_gallery`

### jobs.json
`id, title, org, location, salary, type, url, synopsis, description, departments[], categories[], posted_date, closing_date, logo_url, reports_to, responsibilities, requirements_min, requirements_pref, benefits, about_org, is_featured, is_new, is_archived, show_in_gallery`

### clubs.json
`id, name, sport, league, country, tier, bio, synopsis, logo_url, founded, stadium, capacity, manager, chairman, website, wiki_url, wiki_extract, extra_info, vendor_stack, sportsdb_id, is_featured, is_archived`

### club_people.json
`id, club_id (FK→clubs), name, role, discipline, sub_discipline, bio, linkedin, avatar_url, email, phone, nationality, profile_url, is_featured, team_group, role_category, tm_table`

**Discipline values:** Medical / Doctors | Physiotherapy | Performance / S&C | Psychology | Nutrition / Dietetics | Biomechanics / Analytics | Coaching Staff | Technical / Sporting | Talent ID & Recruitment | Administration | Other

### practitioners.json
`id, name, role, organisation, discipline, sub_discipline, bio, linkedin, avatar_url, email, phone, nationality, is_featured`

### club_vendors.json
`id, club_id (FK→clubs), vendor_id (FK→vendors), notes`

### admin_users.json
`id, email, name, password_hash`

---

## Security notes

- The `GH_TOKEN` is embedded in the client-side `tpe-data.js`.  This is the
  same trust model as the previous Supabase service key.  Use a **fine-grained
  token** scoped to a single repo to minimise exposure.
- `admin_users.json` stores passwords as plain text (matching the previous
  Supabase implementation).  Consider rotating to a hashed scheme over time.
- User preference data (ecosystem selections, saved events/jobs) is **never**
  written to GitHub — it lives only in the browser's localStorage.

---

## Caching behaviour

| Dataset | TTL |
|---|---|
| vendors | 30 min |
| clubs | 15 min |
| practitioners | 15 min |
| news | 10 min |
| events | 10 min |
| jobs | 10 min |

Admin saves automatically bust the relevant cache so changes are visible immediately.

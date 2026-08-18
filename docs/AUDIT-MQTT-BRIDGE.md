# AUDIT — `csms-mqtt-bridge`

**Data:** 2026-08-18 · **Arbore:** `/home/gabi/dev/projects/ospp/csms-mqtt-bridge`
(NU `osp/` — aceeași capcană ca `ts-station-simulator`)
**HEAD:** `2ba00e8`, tag `v0.1.7`, branch `main`, sincron cu `origin/main`, arbore curat.
**Contract citit read-only din** `csms-server` (altă sesiune scrie acolo; nimic atins).
**Nu s-a reparat nimic.** Nu s-a deployat nimic.

---

## 0. Rezumat — ce trebuie citit dacă nu citești tot

1. **Jumătatea de ieșire a podului nu are producător.** Nimic din `csms-server` nu
   scrie vreodată în `mqtt:outgoing`. Ieșirea reală merge prin API-ul REST al EMQX.
   **28% din teste (46 din 164)** acoperă mașinărie care nu poate porni. (§1.3, §4)
2. **Pierdere tăcută, măsurată:** cu `maxmemory-policy=allkeys-lru` — politica pe
   care o rulează `csms-redis` chiar acum — 400 de împingeri au reușit toate, zero
   respinse, **28 au supraviețuit**. 372 de mesaje confirmate brokerului și evacuate
   în tăcere. Sub `noeviction` aceeași probă respinge și nu se pierde nimic. (§2.3)
3. **AUDIT-05 F-02 e VIU în stiva locală:** brokerul raportează sesiunea podului cu
   `session_expiry_interval=0`. Reparația e în arbore la `v0.1.7`; containerul rulează
   **`0.1.5`** — fiindcă `docker-compose.yml:149` are `${BRIDGE_VERSION:-0.1.5}`, adică
   **implicitul e chiar build-ul defect**. Orice mediu care nu pinuiește explicit reia
   defectul. (§2.1, §1.5, §5.3)
4. **Redis căzut nu aruncă și nu pierde — îngheață tot.** Măsurat: promisiunea nu se
   rezolvă și nu se respinge niciodată. Cum mqtt.js pompează pachetele strict unul
   câte unul, un singur `LPUSH` blocat oprește ingestia întregii flote. `/healthz`
   răspunde `ok` pe tot parcursul. Niciun indicator, nicio alertă. (§2.2)
5. **Deduplicarea documentată în contract nu poate funcționa** — dar sistemul e
   totuși sigur, fiindcă serverul deduplică pe alt câmp decât cel prescris. Contractul
   e cel greșit, nu codul. (§2.5)
6. **Premisa „neauditat" e falsă.** AUDIT-05 i-a citit sursa și a produs F-02 cu test
   RED; alte patru documente îl citează. Ce e adevărat: nu are audit de sine stătător,
   iar `metrics.ts` și `state.ts` n-au fost citite niciodată. (§5.4)
7. **Marja de scară e ~50×**, dar zidul nu e unde scrie: EMFILE la ~979 conexiuni
   lovește înaintea lui `max_connections=1024`, la ~195 stații în ipoteza pesimistă,
   pe o flotă de **4**. Nicio alertă nu referă vreo metrică `emqx_*`. (§3.2)

---

## 1. CE FACE — arhitectura reală, măsurată

### 1.1 Formă

Un singur proces Node (6 fișiere sursă, 973 linii), o singură sesiune MQTT, **două**
conexiuni ioredis (`redis.ts:167-182` — a doua e `duplicate()` dedicată lui `BLMOVE`).

| fișier | linii | rol |
| --- | --- | --- |
| `src/mqtt.ts` | 454 | client MQTT 5 mTLS, ack manual, bucla de ieșire |
| `src/redis.ts` | 276 | cozile, plicurile, `parseOutgoingEnvelope` |
| `src/config.ts` | 157 | validare env cu zod |
| `src/index.ts` | 152 | pornire, server HTTP metrics, oprire |
| `src/metrics.ts` | 67 | registrul Prometheus, un singur contor |
| `src/state.ts` | 24 | stare in-memory |

### 1.2 Calea de intrare — singura care poartă trafic

```
stație ──mTLS QoS1──▶ EMQX ──plain sub──▶ POD ──LPUSH──▶ mqtt:incoming ──BLMOVE──▶ mqtt:consume ──▶ dispecer
                              QoS 1                       (db0, fără prefix)   RIGHT/LEFT
```

- Abonare **simplă (non-shared)** la `ospp/v1/stations/+/to-server`, QoS 1
  (`src/mqtt.ts:41`, subscribe la `:328`). `$share/` a fost scos la `2ba00e8`.
- `client.handleMessage` e **suprascris** (`src/mqtt.ts:378-398`): PUBACK-ul pleacă
  spre broker **numai după** ce `LPUSH` s-a rezolvat. Acesta e ancora at-least-once.
- `stationId` se extrage cu `^ospp/v1/stations/(stn_[a-f0-9]{8,60})/to-server$`
  (`src/mqtt.ts:60`). Ce nu se potrivește → **ack + aruncare + contor** (`:134-153`).
- Plicul: `LPUSH mqtt:incoming` (`src/redis.ts:206`). Payload-ul e base64 opac —
  podul nu-l interpretează niciodată.

**Măsurat pe stiva vie** (`redis-cli MONITOR`, 12 s, `csms-redis`):

```
[0 172.18.0.11:38322] "blmove" "mqtt:outgoing" "mqtt:processing" "LEFT" "RIGHT" "5"      ← podul
[0 172.18.0.10:36962] "BLMOVE" "mqtt:incoming" "mqtt:incoming-pending:f9c9b70662ee:1" "RIGHT" "LEFT" "5"   ← consumatorul
[0 172.18.0.10:36962] "SETEX" "mqtt:worker-heartbeat:f9c9b70662ee:1" "90" ...
```

Ambele capete: **aceeași instanță, `db0`, chei fără prefix Laravel**. Confirmat.

Consumatorul: `app/Console/Commands/MqttConsume.php:221-236` — `BLMOVE incoming →
pending RIGHT LEFT`, listă `pending` proprie per worker, `LREM` după succes
(`:136`), replay la boot (`:358-397`), plus `IngressLeaseReaper` programat în
fiecare minut (`routes/console.php:35`). Este un tipar de coadă fiabilă, cu
autovindecare.

### 1.3 Calea de ieșire — mașinărie fără producător

Podul face `BLMOVE mqtt:outgoing → mqtt:processing LEFT RIGHT`
(`src/redis.ts:210-216`), publică, apoi `LREM` (`:190`).

**Nimic nu scrie vreodată în `mqtt:outgoing`.** Verificat direct:

```
grep -rn "mqtt:outgoing" app config database routes tests   →  0 rezultate
toate rpush/lpush din app/:
  MqttConsume.php:450    → queues['incoming']   (reîncercare soft-fail)
  MqttConsume.php:479    → queues['dlq']
  DeadLetterQueue.php:109→ incoming             (replay de operator)
```

Ieșirea reală: `EmqxApiPublisher` → `POST {base}/api/v5/publish`
(`app/Shared/MQTT/EmqxApiPublisher.php:268`), prin `MqttStationGateway`.

Jumătatea de ieșire a fost construită la `a837492` („at-least-once … + BLMOVE
outbound") și **nu a avut producător niciodată** — `git log -S "mqtt:outgoing"`
nu arată niciun commit care s-o fi conectat. E speculativă din naștere.

Ce devine astfel mort în producție: `popOutgoingReliable`, `replayProcessing`,
`parseOutgoingEnvelope`, `ackOf`, `OutgoingEnvelope`, `ReliableOutgoing`,
`mqtt:processing`, `publishEnvelope`, `startOutboundLoop`, `replayProcessingOnce`,
clientul ioredis dedicat de la `44f81d1` (introdus ca să elimine blocarea head-of-line
provocată tocmai de acest `BLMOVE`).

### 1.4 Ce știe podul despre lume

- **Starea nu e citită.** `state.redisConnected`, `state.lastMessageReceivedAt`,
  `state.inflightOutbound` sunt scrise și **nu au niciun cititor** — grep-ul găsește
  doar `state.reconnectCount` (într-un log, `mqtt.ts:346`) și `state.mqttConnected`
  (o gardă, `mqtt.ts:418`). Nimic nu le expune ca metrică.
- **`isReady()` nu are niciun apelant în producție** — doar teste
  (`src/redis.ts:269`; apelanți: `redis.test.ts:236,239,574,578,582`).
- **`/healthz` întoarce 200 necondiționat** (`src/index.ts:93-97`) — nu consultă
  nici MQTT, nici Redis, nici starea. **Și nici nu e folosit nicăieri:** healthcheck-ul
  containerului e `["CMD-SHELL", "kill -0 1"]` (`csms-server/docker-compose.yml:163-168`,
  confirmat pe containerul viu), neschimbat de niciun override, iar `Dockerfile` nu
  are `HEALTHCHECK`. „Healthy" înseamnă strict „PID 1 există".
  (`docs/REPORT-SPRINT-FIX-ISSUES-POST-VALIDATION-20260522T140029Z.md:106` susține că
  healthcheck-ul ar fi `wget … /healthz` — fals față de compose și față de container.)
- Singura metrică proprie: `csms_bridge_topic_drops_total` (`src/metrics.ts:40`).

### 1.5 Unde rulează

Mecanismul de deploy e **Docker Compose și nimic altceva** — niciun manifest
Kubernetes, nicio unitate systemd, nicio intrare supervisord nu referă podul
nicăieri sub `~/dev/projects/`.

| unitate | fișier:linie | `MQTT_CLIENT_ID` | broker |
| --- | --- | --- | --- |
| definiție de bază (profil `sidecar`) | `csms-server/docker-compose.yml:148-178` | — (vine din override) | — |
| local dev (override **netracked**) | `docker-compose.override.yml:32-59` | `csms-dev-server-1` | `mqtts://emqx:8883` |
| UAT | `docker-compose.uat.yml:126-137` | `csms-uat-server-1` | `mqtts://mqtt-uat.onestoppay.ro:8883` |
| PROD | `docker-compose.prod.yml:129-150` | `csms-prod-server-1` | `mqtts://mqtt.onestoppay.ro:8883` |

Limite: 100 MB / 0,2 CPU, `restart: unless-stopped` moștenit în **toate** mediile
(`docs/SIDECAR-DEPLOYMENT.md:281` susține că „Prod folosește `always`" — **fals**,
`docker-compose.prod.yml` nu setează niciun `restart:`; containerul viu confirmă
`unless-stopped`).

Ambele scripturi de deploy îl pornesc necondiționat și abandonează deploy-ul dacă
eșuează (`scripts/deploy-uat.sh:487-496`, `scripts/deploy-prod.sh:277-284`).
Lanțul de release e real: tag `v*.*.*` → GHCR multi-arch cu provenance+sbom
(`.github/workflows/release.yml:13-16,73-85`); toate tag-urile `v0.1.0`…`v0.1.7`
există pe `origin`.

**Cauza rădăcină a §2.1 e aici — versiunea implicită e build-ul stricat:**

```
docker-compose.yml:149    ghcr.io/ospp-org/csms-mqtt-bridge:${BRIDGE_VERSION:-0.1.5}
.env.example:114          BRIDGE_VERSION=0.1.4
reparația F-02            v0.1.7  = 2ba00e8 = HEAD
```

`v0.1.5` e exact build-ul defect: `git show v0.1.5:src/mqtt.ts` folosește
`$share/ospp-servers/…`, iar `git show v0.1.5:src/config.ts` **nu are** cheia
`MQTT_SESSION_EXPIRY_INTERVAL` — ambele jumătăți ale F-02. Orice mediu care nu
pinuiește explicit `BRIDGE_VERSION` **reia defectul**. Stiva locală rulează `0.1.5`
chiar acum. Spus deja în arbore, la
`csms-server/docs/INTEGRATOR-HANDOFF-PROVISIONING-BOOT.md:1121`.

Colateral: `CHANGELOG.md` al podului are titluri doar până la `## [0.1.3]` —
release-urile 0.1.4…0.1.7 sunt tăgăduite și publicate **fără nicio intrare**.

Al doilea defect de deploy: rețeta money-e2e
(`docker-compose.money-e2e.yml:14-17`, `tools/bt-ipay-double/README.md:48-50`) trece
`-f` explicit, ceea ce suprimă încărcarea automată a `docker-compose.override.yml`;
`docker-compose.dev.yml` nu are serviciul `mqtt-bridge`; iar baza nu furnizează
niciuna dintre cele cinci variabile obligatorii. Rețeta documentată pornește deci
un pod care **pică pe validarea zod și iese cu 1** (`src/config.ts:56-62,123-129`).

### 1.6 Rendez-vous-ul Redis — aliniat pe o singură coordonată

Podul își ia ținta din `REDIS_URL`; consumatorul, din conexiunea `mqtt`
(`config/database.php:221-229`). Comparate coordonată cu coordonată:

| coordonată | pod (compose) | Laravel `mqtt` | divergă când |
| --- | --- | --- | --- |
| gazdă | `${REDIS_MQTT_HOST:-redis}` | `env('REDIS_MQTT_HOST', env('REDIS_HOST',…))` | **aliniat** (reparat la `66dcca3`) |
| port | **`6379` hardcodat** | `env('REDIS_MQTT_PORT', …)` | operatorul setează `REDIS_MQTT_PORT ≠ 6379` |
| bază | **`/0` hardcodat** | `env('REDIS_MQTT_DB', env('REDIS_DB','0'))` | operatorul setează `REDIS_MQTT_DB ≠ 0` |
| parolă | **doar `${REDIS_PASSWORD}`** | `env('REDIS_MQTT_PASSWORD', env('REDIS_PASSWORD'))` | operatorul setează `REDIS_MQTT_PASSWORD` |

Ambele axe divergente sunt **invitate activ** de fișierul-exemplu livrat:
`.env.prod.example:83` oferă `# REDIS_MQTT_DB=0`, iar `:84` oferă
`# REDIS_MQTT_PASSWORD=GENERATED_BY_SCRIPT`. Cazul parolei e cel mai ascuțit:
serverul `redis-queue` chiar onorează `REDIS_MQTT_PASSWORD`
(`docker-compose.yml:132`), deci setarea ei face coada să ceară o parolă pe care
podul n-o trimite niciodată. Iar `GENERATED_BY_SCRIPT` e o promisiune goală —
`grep REDIS_MQTT` peste `scripts/generate-prod-credentials.sh` și
`generate-uat-credentials.sh` nu întoarce nimic, iar `preflight-env-enums.sh`
nu verifică niciuna. `.env.prod.example:79` numește simptomul, dar doar pentru
gazdă: *„Miss (3) and the worker BRPOPs an empty queue while the bridge fills an orphan."*

---

## 2. CĂI DE EȘEC

### 2.1 Cădere a podului cu mesaje în zbor

Depinde exclusiv de expirarea sesiunii. **Măsurat pe brokerul viu:**

```
emqx ctl clients list →
Client(csms-dev-server-1, clean_start=false, keepalive=30,
       session_expiry_interval=0, subscriptions=1, inflight=0,
       delivered_msgs=592, enqueued_msgs=0, dropped_msgs=0)
```

`session_expiry_interval=0` ⇒ la deconectare brokerul **șterge sesiunea**, cu
abonament cu tot. Mesajele QoS 1 publicate de stații în fereastra de indisponibilitate
nu au abonat și sunt aruncate de broker. **Aceasta este exact AUDIT-05 F-02, viu.**

Cauza e că imaginea care rulează e `ghcr.io/ospp-org/csms-mqtt-bridge:**0.1.5**`,
iar `MQTT_SESSION_EXPIRY_INTERVAL` a apărut în `0.1.6` (`e0b25d5`), urmat de
fix-forward-ul din `0.1.7` (`2ba00e8`).

**La HEAD** (`v0.1.7`) comportamentul e cel corect: `sessionExpiryInterval: 3600`
(`src/config.ts:94`, `src/mqtt.ts:95`), abonament simplu, iar `stop()` **nu**
dezabonează deliberat (`src/mqtt.ts:419-426`) — brokerul păstrează coada și o
redă la reconectare.

Plafonul acelei cozi e al brokerului, nu al podului: `max_mqueue_len = 1000`
(măsurat, `emqx ctl conf show mqtt`). Peste 1000 de mesaje acumulate cât podul e
jos, brokerul aruncă.

### 2.2 Redis nu răspunde — nu aruncă, nu pierde, ÎNGHEAȚĂ

Probă rulată cu codul real al podului (`dist/redis.js`, reconstruit din sursa HEAD),
împotriva unui Redis de unică folosință omorât cu `docker kill`:

```
t+0.0  conectat
t+0.0  kill redis; 500 × pushIncoming puse în lucru
t+10.3 înainte de repornire: resolved=0  rejected=0      ← nici rezolvate, nici respinse
t+10.5 redis repornit
t+13.7 redis ready
t+15.5 resolved=500 rejected=0  LLEN=500                 ← nimic pierdut
```

Cauza: `maxRetriesPerRequest: null` (`src/redis.ts:171`) plus coada offline
implicită a ioredis. Comanda nu eșuează niciodată — așteaptă la nesfârșit.
(Prima mea probă a raportat `LLEN=0` după repornire; era doar backoff, nu pierdere.
Corectat prin re-măsurare cu jurnalizarea evenimentelor de ciclu de viață.)

**Consecința gravă nu e pierderea, ci blocajul total.** mqtt.js pompează pachetele
de intrare **strict unul câte unul**: `work()` scoate un singur pachet și avansează
doar prin `nextTickWork`, după ce callback-ul handler-ului curent a fost apelat
(`node_modules/mqtt/build/lib/client.js:262-296`; pentru QoS 1, PUBACK-ul e legat
de acel callback la `handlers/publish.js:87-92`). Un singur `LPUSH` blocat ⇒
**nicio stație nu mai e ingerată**, iar contrapresiunea urcă până în socket.

Ce vede lumea din afară în acest timp: containerul e `healthy` (fiindcă PID 1
trăiește — §1.4), `/healthz` ar răspunde `ok` dacă l-ar întreba cineva, `up` → 1,
niciun contor nu se mișcă. **Nu există alertă `up{job=...}` nicăieri** în
`docker/prometheus/rules/alerts.yml`.
Singura alertă a podului, `BridgeSilentTopicDropsDetected` (`alerts.yml:506`), se
declanșează doar când podul **funcționează** și aruncă.

Recuperarea e automată, dar întârziată de backoff-ul exponențial propriu
(`src/redis.ts:118-122`). Din funcția exportată de repo:

| încercare | 7 | 8 | 9 | 10 | 11 |
| --- | --- | --- | --- | --- | --- |
| pauză | 6,6 s | 13,0 s | 25,8 s | 30,1 s | 30,1 s |
| cumulat | 13,3 s | 26,3 s | 52,1 s | 82,2 s | 112,4 s |

După o pană Redis mai lungă de ~1 minut, podul poate mai aștepta **până la 30 s**
după ce Redis a revenit.

### 2.3 Redis sub presiune de memorie — AICI se pierd mesaje, tăcut

Aceeași probă, aceeași cale de cod, două politici:

| `maxmemory-policy` | împinse | rezolvate | respinse | supraviețuitoare |
| --- | --- | --- | --- | --- |
| `noeviction` | 400 | 30 | **1** (`OOM command not allowed`) | 30 |
| `allkeys-lru` | 400 | **400** | **0** | **28** |

Sub `noeviction`, respingerea urcă prin `handleInbound` → callback cu eroare →
mqtt.js sare peste PUBACK → brokerul păstrează mesajul. **Corect.**

Sub `allkeys-lru`, `LPUSH` raportează succes, podul confirmă brokerului, brokerul
își aruncă copia, iar Redis evacuează intrarea. **372 de mesaje dispărute fără o
eroare, un log sau o metrică.**

Politica măsurată acum pe `csms-redis`: `maxmemory 268435456`, `maxmemory-policy
allkeys-lru`, `appendonly yes`, folosit 8,16 MB din 256 MB.

Garda există — dar pe cititor, nu pe scriitor: `MqttConsume::assertQueueRedisDurable()`
(`app/Console/Commands/MqttConsume.php:173-198`) aruncă fatal în `production|staging|uat`
dacă politica nu e `noeviction`, și doar avertizează în local. **Podul — cel care
scrie — nu are niciun echivalent**: `grep -riE "maxmemory|noeviction" src/` → 0.

Instanța dedicată corectă *există și rulează*: `csms-redis-queue`, măsurată
`noeviction`, 256 MB, AOF — și e **complet goală**, cu keyspace vid. Activarea e o
poartă de deploy cunoscută și încă netrecută, descrisă chiar în compose
(`docker-compose.yml:118-122`): „*enable this profile + set `REDIS_MQTT_HOST=redis-queue`
… AND repoint the bridge's `REDIS_URL` … the bridge WRITES the queue, so both the
reader and the writer must rendezvous on this instance*".

Contractul semnalase riscul în proză (`docs/REDIS-QUEUE-CONTRACT.md:64-69`, „*items
COULD be evicted*"). Măsurătoarea arată că **se evacuează**, că pierderea e tăcută
și că nimic nu o numără.

### 2.4 Mesaj malformat

| caz | ce face podul | unde |
| --- | --- | --- |
| topic care nu se potrivește regex-ului | **ack + aruncare** + `topicDropsTotal.inc()` + log `warn` | `mqtt.ts:134-153` |
| payload corupt / non-OSPP | **trece nevăzut** — podul nu parsează niciodată payload-ul | `mqtt.ts:162` |
| plic de ieșire invalid | `LREM` din processing + re-aruncare + log | `redis.ts:220-227` |

Podul **nu are coadă de erori proprie**. DLQ-ul real e al serverului
(`mqtt:incoming-dlq`, `MqttConsume.php:479`), cu unelte de operator
(`mqtt:dlq:list|inspect|replay|purge`) și alertă pe adâncime
(`alerts.yml:555`, `csms_mqtt_queue_depth{queue="dlq"} > 0`). Un payload stricat
ajunge deci în DLQ — dar **numai dacă topicul a fost bun**. Dacă topicul e greșit,
mesajul moare la pod, iar DLQ-ul nu-l vede niciodată.

**Aruncarea de topic e reală și curentă, nu teoretică:**

```
csms_bridge_topic_drops_total{reason="non_compliant_station_id"} 161
event=topic_dropped topic=ospp/v1/stations/stn_s2_sweep/to-server
```

161 de mesaje aruncate față de `delivered_msgs=592` la broker — **27% din tot ce a
livrat brokerul**. `stn_s2_sweep` nu e hex, deci cade pe `stn_[a-f0-9]{8,60}`.
Acest drum e însă **numărat, jurnalizat și alertat** (`alerts.yml:505-514`,
`increase(...[5m]) > 5`) — e singura cale de eșec a podului care are instrument complet.

### 2.5 Duplicat — contractul prescrie un mecanism care nu poate funcționa

`messageId` din plic e **un UUID v4 proaspăt, generat la fiecare primire**
(`src/mqtt.ts:165`). O redare a aceluiași pachet de către broker produce deci un
`messageId` **diferit**.

Contractul cere explicit consumatorului să deduplice pe exact acel câmp:

> `docs/REDIS-QUEUE-CONTRACT.md:251-256` — „*Idempotency: dedupe processed inbound
> messages by `messageId`. After a Redis or bridge restart, an envelope … may appear
> again if the broker re-delivers*"
> `:270-272` — „*Treat `messageId` as the dedupe key.*"

Scenariul pe care contractul îl numește (redare după repornire) este **exact** cel în
care cheia lui nu poate potrivi. Dacă serverul ar fi urmat contractul, fiecare redare
ar fi fost procesată de două ori.

**Serverul nu-l urmează, și de aceea sistemul e sigur.** Deduplicarea reală cade pe
`messageId`-ul OSPP **din interiorul** payload-ului decodat: `MqttConsume.php:262`
decodează, `:285` trimite doar `$rawMessage` dispecerului,
`MessageFactory.php:109` citește `$data['messageId']`, iar `MessageDispatcher.php:219`
îl folosește drept cheie. Registrul (`DeduplicationRegistry.php:277,282,292`) ține
un marcaj DONE (ZSET, TTL 3600 s), o revendicare `SET NX EX` (90 s) și un răspuns
în cache (7200 s). Serverul își documentează chiar distincția la
`MqttConsume.php:270-280` („*Same OSPP message re-delivered by the broker has
different envelope_ids but the same message_id*").

**Concluzie: codul e corect, contractul e greșit.** Riscul e că un consumator viitor
care implementează contractul literal va construi o deduplicare care nu prinde nimic.

### 2.6 Ordine

**Măsurat empiric pe Redis real**, nu dedus:

```
podul: LPUSH A, LPUSH B, LPUSH C   →  listă L..R:  C B A
consumatorul: BLMOVE ... RIGHT     →  scoate:      A B C     ✓ ordinea de pe fir
```

Perechea `LPUSH` (pod, `redis.ts:206`) ↔ `BLMOVE … RIGHT` (consumator,
`MqttConsume.php:221-236`) este **FIFO corect**, în ciuda faptului că
contractul prescrie `BRPOP` (`REDIS-QUEUE-CONTRACT.md:39,267`) — o formulare stale,
dar cu aceeași direcție, deci inofensivă.

Un al doilea rezultat, în afara podului dar pe suprafața lui de contract:

```
listă L..R: D C B A ; consumatorul scoate A; A eșuează soft; RPUSH A
listă L..R: D C B A ; următoarele scoateri:  A B C D
```

O reîncercare `RPUSH` (`MqttConsume.php:450`) aterizează **la capătul din care
consumatorul scoate** — deci `A` revine **imediat, înaintea lui B, C, D**. Ordinea
de pe fir se **păstrează**; nu există inversare.

Două comentarii din `csms-server` descriu invers acest mecanism —
`app/Modules/Session/Handlers/SessionEndedHandler.php:100-103` și
`tests/Integration/.../StopOrderInversionTest.php:50-54` susțin că plicul ajunge
„*behind the EVENT that followed it on the wire*". Măsurătoarea spune contrariul.
**Nu am atins acele fișiere** (alt repo, altă sesiune scrie acolo) — le semnalez ca
premisă de verificat acolo. Consecința reală nu e inversarea, ci **blocarea capului
de coadă**: `MqttConsume.php:443-448` face `sleep(2|4|8)` sincron *înainte* de
re-împingere, iar mesajul revine primul — deci un plic care eșuează soft ține toată
ingestia până la ~14 s, apoi trece în DLQ.

---

## 3. SCARĂ — ce cade și la ce număr

### 3.1 Flota reală

**4 stații în producție**, 4 în UAT (`csms-server/docs/KNOWN-ISSUES.md:1023,3578,3579`).
Volumul măsurat acolo: **2794 mesaje de intrare / 28 zile / 4 stații** ≈ 100 pe zi
≈ **0,0012 msg/s**. (Cifră din document, nu măsurată de mine — nu am acces la PROD.)

### 3.2 Zidul: descriptorii de fișier ai brokerului, nu podul

Podul nu e limita. Prima barieră e EMQX, iar ea vine **înaintea** setării care ar
trebui s-o guverneze:

- `max_connections` e lăsat `infinity`, ceea ce esockd rezolvă la `min(ulimit -Sn,
  process_limit)` = **1024** (`csms-server/docker/emqx/emqx.conf.production:127-135`).
- **Verificat pe viu:** `emqx ctl listeners` → `max_conns : 1024`; `ulimit -n` în
  container → **1024**.
- `ulimits: nofile:` **nu apare în niciun fișier compose** — deci UAT și PROD au
  același 1024.
- beam.smp consumă ~45 descriptori, rămân **~979 pentru conexiuni**
  (`emqx.conf.production:150`). Tabelul de acolo (`:152-157`): 1 conexiune/stație →
  ~979 stații; 2 → ~489; 3 → ~326; **5 (takeover + handshake eșuat + LWT) → ~195**.
- Modul de eșec e cel urât: **EMFILE lovește la ~979 înainte ca `max_connections=1024`
  să apuce să refuze curat** (`:162-167`) — refuzul `{error,maxlimit}` e
  neconstructibil, iar acceptorul intră în cicluri de suspendare de 1 s în timp ce
  rotația de log, CRL-ul și mnesia încep să pice.
- `emqx.conf.production:173-176` notează chiar acolo că nicio regulă din
  `alerts.yml` nu referă vreo metrică `emqx_*`. Confirmat: **zero** referințe.
  **Plafonul e invizibil până când mușcă.**

Că takeover-ul e real, nu teoretic: `emqx ctl listeners` raportează pe viu
`shutdown_count : [{takenover,243},{kicked,82},{expired,281},{banned,81},…]`.

**Marja: ~50× pe ipoteza pesimistă (195) și ~245× pe cea optimistă (979),
față de 4 stații.**

### 3.3 Restul plafoanelor, măsurate

| plafon | valoare | ce se întâmplă la depășire |
| --- | --- | --- |
| `max_mqueue_len` | **1000** | mesaje ținute pentru sesiunea offline a podului; peste — brokerul **aruncă**. Primul zid la o cădere prelungită. |
| `max_inflight` | **32** | QoS 1 neconfirmate simultan spre pod. Cu pompa serială, plafonul efectiv e oricum 1. |
| `max_packet_size` | **64 KB** | payload mai mare e refuzat de broker |
| `max_conns` / listener | **1024** (curent 20) | vezi §3.2 — EMFILE lovește primul |
| `keepalive` | 30 s × 1,5 | brokerul declară sesiunea moartă după **45 s** |
| `session_expiry_interval` | **0** viu / 3600 la HEAD | §2.1 |
| memorie pod | limită **100 MB**, măsurat **22,27 MiB** (22%) | podul nu ține stare per stație — `state.ts:9-15` sunt cinci scalari — deci amprenta e per mesaj, nu proporțională cu flota |
| Redis `maxmemory` | 256 MB, `allkeys-lru` | §2.3 |

**Redis nu e strangularea.** Măsurat cu codul real, secvențial, așa cum îl rulează
pompa: **3000 împingeri în 343 ms = 8751 msg/s** (0,114 ms fiecare). Pipelinat ar da
62 831 msg/s — diferența arată exact cât costă serializarea, dar chiar și serial
Redis e cu ordine de mărime mai rapid decât rețeaua și TLS-ul. (Buclă locală;
rețeaua de containere adaugă latență — e o limită superioară optimistă.)

### 3.4 Ce cade întâi, în ordine

1. **La o cădere a podului** — `max_mqueue_len=1000`. Cu `session_expiry_interval=0`
   (starea de azi) plafonul e **0**: se pierde tot, imediat.
2. **La o pană Redis** — nimic nu se pierde, dar ingestia e **complet oprită** cât
   ține pana, plus până la 30 s de backoff. Invizibil din exterior.
3. **La presiune de memorie pe Redis** — evacuare tăcută (§2.3).
4. **La ~195 de stații** — EMFILE pe broker, fără alertă (§3.2).
5. **Un singur pod.** `mqtt:processing` e singleton, declarat „single-instance scope"
   (`src/config.ts:97-101`). Trei încuietori independente împiedică azi un al doilea:
   `container_name` fix în fiecare override, `MQTT_CLIENT_ID` fix (două containere
   ar intra în buclă de takeover), și absența oricărui `replicas:`. ACL-ul EMQX **nu**
   e o încuietoare — e pe prefix (`^csms\-prod\-`), deci un `csms-prod-server-2` ar
   fi autorizat. Cum calea de ieșire e moartă, restricția e azi teoretică; ar redeveni
   reală dacă ieșirea s-ar conecta vreodată.

## 4. DOVEDIT / NEDOVEDIT

**Suita: 164 de teste, 4 fișiere, verzi în 2,46 s** (`npm run test`, măsurat, nu moștenit).
**CI există și rulează** — `lint → typecheck → test → build → verify dist`, pe `push`
la `main` și pe fiecare PR (`.github/workflows/ci.yml:37-50`). Nu e un repo cu teste
care nu rulează nicăieri.

### Unde stau cele 164

| zonă | teste | % |
| --- | --- | --- |
| validare config/env | 56 | 34% |
| **calea de ieșire (fără producător)** | **46** | **28%** |
| intrare (handleMessage, topic, drops) | 39 | 24% |
| opțiuni de conectare / ciclu de viață / stop | 23 | 14% |

Peste o treime din suită validează variabile de mediu. Peste un sfert exercită
mașinărie care nu poate porni în producție. Calea prin care trece fiecare mesaj
al fiecărei stații are **39 de teste**.

### Ce ar face fiecare probă să pice

| proba | pică dacă |
| --- | --- |
| `pushes envelope to redis AND acks` (`mqtt.test.ts:508`) | ack-ul se trimite fără LPUSH, sau plicul își schimbă forma |
| `does NOT ack … when redis push fails` (`:534`) | handler-ul înghite eroarea și confirmă |
| `acks … on invalid topic` (`:549`) | podul ar reține gunoiul și l-ar reda la infinit |
| `subscribes to the PLAIN … topic (not $share/)` (`:431`) | cineva reintroduce `$share/` — regresia F-02 |
| `does NOT unsubscribe on stop` (`:800`) | `stop()` dezabonează → sesiunea pierde abonamentul |
| `advertises the session-persistence CONNECT knobs` (`:311`) | `sessionExpiryInterval` sau `clean:false` dispar |
| `LPUSH resolves while BLMOVE is still pending` (`redis.test.ts:452`) | s-ar reveni la un singur client ioredis |
| `parseOutgoingEnvelope — version` (×4) | s-ar accepta un plic de versiune necunoscută |
| `positiveInt` pe `MQTT_SESSION_EXPIRY_INTERVAL` | `0` ar redeveni configurabil (bug-ul F-02 prin config) |

### NEDOVEDIT — găuri, cu mecanismul lor

1. **Zero teste de integrare.** Niciun test nu atinge un Redis real, un broker real
   sau un capăt la capăt. Toate cele 164 sunt unitare cu duble. Nu există `docker-compose`
   de test, nici job CI cu servicii.
2. **`src/index.ts` nu are niciun test.** Deci: ordinea de pornire, oprirea grațioasă,
   `/healthz`, `/metrics`, tratarea semnalelor, `process.exit` — **nimic** nu e acoperit.
3. **`does NOT ack … when redis push fails` testează o cădere care nu se produce.**
   Testul mochează `pushIncoming` cu `Promise.reject` (`mqtt.test.ts:537`). Am măsurat
   (§2.2) că un Redis căzut **nu respinge niciodată** — promisiunea rămâne suspendată.
   Calea de respingere e reală, dar se atinge prin *erori de răspuns* (OOM, WRONGTYPE,
   auth), nu prin pierderea conexiunii. Testul demonstrează traducerea eroare→no-ack;
   **nu** demonstrează comportamentul la „Redis down", deși așa se numește.
4. **Nimic nu acoperă comportamentul sub `allkeys-lru`** — pierderea din §2.3 nu ar
   face nicio probă să pice.
5. **Nimic nu verifică rendez-vous-ul scriitor↔cititor.** Că podul și consumatorul
   nimeresc aceeași instanță, aceeași bază și aceleași chei ține de convenție și de
   un singur test **din celălalt repo** (`tests/Feature/Config/MqttQueueConnectionTest.php`).
   Podul nu are nicio probă pe subiect.
6. **`--passWithNoTests`** (`package.json`) — o rulare care nu colectează nimic iese
   verde. Un import stricat care golește colectarea trece CI-ul.
7. **Suita de fir a serverului OCOLEȘTE podul.** `tests/MqttIntegration/MqttMoneyTestCase.php:126-160`
   își face propriul client mTLS și se abonează direct la broker, apoi cheamă
   `MessageDispatcher` în proces (`:183-225`) — o reimplementare a
   `MqttConsume::handleEnvelope`, nu consumatorul real. Deci **podul nu e în cale**.
   Mai rău: când rulează, consumatorul real concurează cu harnașamentul pe același
   filtru de topic — măsurat în arbore, **2/39 pică**, iar cu `docker stop
   csms-mqtt-consumer` **39/39 trec** (`MqttIntegrationTestCase.php:60-77`). Direcția
   periculoasă e trecerea, cum s-a stabilit deja.
   **Niciun test, nicăieri, nu pune un pod real să scrie un plic real pe care un
   `mqtt:consume` real să-l citească.**

---

## 5. ISTORIC — cele două defecte cunoscute

### 5.1 „Baze Redis diferite între scriitor și cititor" — ÎNCHIS, verificat azi

Incidentul e real și e consemnat: `AUDIT-UAT-PROD-MIRROR.md:311-315` descrie workerul
UAT citind `csms_api_uat_database_mqtt:incoming` și golind nimic — **prefixul Laravel**,
nu indexul bazei, era mecanismul. Reparat prin commit `800ed13`.

Reparația de azi: conexiunea Redis dedicată `mqtt` cu `'prefix' => ''` explicit
(`config/database.php:221-229`), pinuită de `tests/Feature/Config/MqttQueueConnectionTest.php:43,68,77`.

**Verificat pe viu, nu preluat:** `MONITOR` arată ambele capete pe `csms-redis`,
`db0`, chei brute `mqtt:incoming` / `mqtt:outgoing`, fără prefix. **Defectul nu mai e
prezent.**

Ce rămâne din el: garda e **într-un singur sens**. Podul își ia ținta din `REDIS_URL`,
consumatorul din `REDIS_MQTT_*`; **nimic nu compară cele două**. Iar
`.env.example:129` din `csms-server` livrează un `# MQTT_WORKER_REDIS_CONNECTION=default`
comentat — decomentat, repointează workerul pe conexiunea *cu prefix* și recreează
exact eșecul. Migrarea planificată spre `redis-queue` (§2.3) mută ambele capete și
va trebui făcută **simultan**, altfel reproduce incidentul.

### 5.2 „Grupul de consum dispărea în timpul rulării" — PREMISĂ DIZOLVATĂ

Nu există grupuri de consum, fiindcă **nu există Redis Streams**. Zero
`XADD`/`XREADGROUP`/`XGROUP`/`XACK`/`XCLAIM` în `app/`, `config/`, `routes/`,
`database/`, `tests/`. Singurele apariții din repo sunt în proză, iar
`git log -S "XREADGROUP" --all` dă două commit-uri, ambele doar de documentație.

Nu am găsit nicio dovadă că o implementare pe Streams ar fi existat vreodată aici;
designul pe liste pare original. **Întrebarea a mai fost pusă și răspunsă de două ori**:
`docs/audit-pipeline-mqtt-20260702.md:16,29` („*NU Redis Streams!*", grep negativ) și
`docs/remediation/WORKLOG.md:67`, care notează explicit că *memoria* unei sesiuni
anterioare purta aceeași credință falsă despre Streams. Aceasta este a treia oară.

**Reparația discutată atunci — „lipsa grupului detectată în buclă și recreată, deci
consumator care se vindecă singur" — există azi, în forma echivalentă pe liste:**

| ce | unde |
| --- | --- |
| listă `pending` proprie per worker `{pending}:{host}:{pid}` | `MqttConsume.php:302-305` |
| heartbeat `SETEX`, TTL 90 s, reîmprospătat în fiecare iterație | `MqttConsume.php:323-332` |
| mulțime de proprietari | `MqttConsume.php:310-316` |
| replay al listei proprii la boot | `MqttConsume.php:358-397` |
| recuperarea listei unui worker mort | `IngressLeaseReaper.php:59-107` |
| **rulat în fiecare minut, nu doar la pornire** | `routes/console.php:35` |

Deci proprietatea cerută — „dacă structura de consum dispare, ceva o reface în buclă"
— **e implementată**, dar pentru un alt mecanism decât cel din amintire.

### 5.3 Al treilea defect, care nu era pe listă: F-02 nedeployat

Vezi §2.1. Reparația e în arbore la `v0.1.7`; producția locală rulează `0.1.5`.
Aceasta e o instanță din clasa „*reparația există, arborele e verde, artefactul care
rulează e altul*".

### 5.4 Premisa „podul e neauditat" — FALSĂ, dar aproape

Podul **a fost** examinat la nivel de sursă, iar una dintre examinări a produs o
reparație reală în cod. Ce nu există e un audit **de sine stătător** al lui — nu
are analog al seriei `AUDIT-01…08` a serverului.

| document (în `csms-server`) | ce a acoperit |
| --- | --- |
| `docs/audits/AUDIT-05-concurrency-distributed-state.md:25,32,142-199,835` | l-a listat explicit ca arbore inspectat la `v0.1.5`, i-a rulat suita (162 teste), iar **F-02** e o constatare dedicată pe `src/mqtt.ts` cu test RED; a verificat pozitiv și granița de ack |
| `docs/audits/REMEDIATION-WAVE-3.md:49,724+` | ARC 9 — reparația și verificarea; tabelul notează `91e4e42 (162/0) → e0b25d5 (164/0)` |
| `docs/audits/adjudication/RECON-WIRE-LIFECYCLES.md:1345-1346` | cea mai adâncă citire în afara AUDIT-05: 10 citate din 5 din cele 6 fișiere, **inclusiv defectul de ordine la pornire** (§6 C5) |
| `docs/audits/adjudication/SWEEP-WIRE-LIFECYCLE-DEBTS.md:1453` | 4 citate; lasă CN-ul certificatului de prod explicit nerezolvat |
| `docs/RECON-ONLINE-FIRMWARE-FACING-20260613.md:327-333` | subsecțiune scurtă: podul e un releu pur |

**Nouă documente au declinat explicit să-l auditeze**, între 2026-06-13 și
2026-08-18 — printre care `docs/audits/RECON-EVIDENCE-LAYER.md:29-30` („*Nu l-am
auditat.*"), `AUDIT-01:676`, `AUDIT-03:578-579`, `docs/audit-pipeline-mqtt-20260702.md:151`,
`2-AUDIT-BOOT.md:123,792,1179,1187`. Unul se contrazice singur:
`RECON-PROVISIONING-ARC.md` citează `src/mqtt.ts:99` la `:1360`, dar afirmă la
`:1870` că repo-ul *„was not swept."*

Adâncimea, cuantificată: constatările dedicate acoperă **un singur comportament**
(persistența sesiunii MQTT 5) dintr-un singur fișier. **`metrics.ts` și `state.ts`
nu au fost examinate niciodată de niciun audit** — de acolo vin C3 și §1.4.

Atenție și la o omonimie: cele două `AUDIT-UAT-PROD-MIRROR.md` **nu sunt același
fișier**. Cel din `csms-server` (1076 linii, v3.5) e documentul viu — cel care a
specificat podul în existență. Cel din acest repo (581 linii) e un instantaneu
**înghețat v2 / 2026-04-27**, cu 2 commit-uri în total, care încă numește portul
greșit al brokerului (`8884` la `:5`, față de `8883` deployat). E un jurnal de
proiectare, nu o recenzie de cod.

---

## 6. RĂMÂNE

### Cod lipsă

| # | ce | de ce contează |
| --- | --- | --- |
| C1 | Podul nu are nicio gardă `maxmemory-policy`. Cititorul are una fatală (`MqttConsume.php:173-198`); scriitorul, niciuna. | §2.3 — scriitorul e cel care pierde tăcut |
| C2 | `/healthz` întoarce 200 necondiționat (`index.ts:93-97`); `isReady()` există și **nu e chemat niciodată** în producție; iar healthcheck-ul containerului nici măcar nu interoghează `/healthz` — e `kill -0 1`. | §2.2 — un pod înghețat raportează „healthy" pe toate cele trei niveluri |
| C3 | `state.redisConnected`, `lastMessageReceivedAt`, `inflightOutbound` sunt scrise și necitite; nicio metrică nu le expune. | fără ele, blocajul din §2.2 e invizibil |
| C4 | Niciun timeout pe `pushIncoming`. | un Redis care răspunde lent, dar nu cade, îngheață la fel |
| C5 | Ordinea de pornire documentată la `index.ts:57-63` **nu e implementată**: IIFE-ul de la `:66-73` nu e așteptat, iar `startMqttClient` de la `:75` pornește imediat. Funcționează doar din accidentul cozii offline ioredis. **Deja raportat** în `csms-server/docs/audits/adjudication/RECON-WIRE-LIFECYCLES.md:1345-1346` — l-am regăsit independent, e încă deschis. | garanția scrisă nu există |
| C6 | Calea de ieșire — de decis dacă se conectează sau se scoate (§1.3). | 28% din teste păzesc cod mort |
| C7 | `ulimits: nofile:` lipsește din **toate** fișierele compose ⇒ brokerul rămâne la 1024 descriptori. | §3.2 — zidul de scară, azi implicit |
| C8 | `REDIS_URL` al podului hardcodează portul, baza și schema parolei, în timp ce Laravel citește `REDIS_MQTT_PORT/DB/PASSWORD`. | §1.6 — trei axe pe care split-brain-ul se poate reforma |
| C9 | `CHANGELOG.md` se oprește la `0.1.3`; 0.1.4…0.1.7 sunt publicate fără intrare. | nu se poate citi ce s-a schimbat între imagini |

### Dovadă lipsă

| # | ce |
| --- | --- |
| D1 | Zero teste de integrare; `src/index.ts` complet neacoperit |
| D2 | Nicio probă că scriitorul și cititorul nimeresc aceeași instanță/bază/chei |
| D3 | Nicio probă pe comportamentul sub evacuare (`allkeys-lru`) |
| D4 | Testul „redis down" nu reproduce Redis down (§4.3) |
| D5 | Niciun test end-to-end cu pod real + `mqtt:consume` real |
| D6 | Nicio alertă `up{job=...}`; un pod mort sau înghețat nu declanșează nimic |
| D7 | Nicio alertă pe vreo metrică `emqx_*` ⇒ plafonul de conexiuni e invizibil până la EMFILE |
| D8 | Nicio verificare preflight pe `REDIS_MQTT_*`, deși `.env.prod.example:84` promite `GENERATED_BY_SCRIPT` (§1.6) |
| D9 | Rețeta money-e2e documentată pornește un pod care iese cu 1 — nimic n-o testează (§1.5) |

### Decizie lipsă

| # | întrebarea |
| --- | --- |
| E1 | **Când se activează `redis-queue`?** Poarta e armată și documentată (`docker-compose.yml:118-122`); până atunci coada stă pe instanța care evacuează. Ambele capete trebuie mutate în același pas. |
| E2 | **Se deployază `v0.1.7`, și se mută implicitul?** Cât timp `docker-compose.yml:149` are `:-0.1.5`, un mediu nou ia build-ul defect din start (§1.5). |
| E3 | **Calea de ieșire: se conectează sau se scoate?** Serverul a ales REST-ul EMQX și nu s-a întors. |
| E4 | **Se corectează contractul pe deduplicare?** `REDIS-QUEUE-CONTRACT.md:251-256,270-272` prescrie o cheie care nu poate potrivi (§2.5). |
| E5 | **Cine deține `stn_s2_sweep`?** 161 de mesaje, 27% din livrări, aruncate legitim de o regulă corectă. |
| E6 | **Se ridică `nofile` pe broker?** Marja e ~50×, dar modul de eșec e EMFILE, nu un refuz curat (§3.2). |

### Derivă de documentație — de reparat odată cu oricare din cele de mai sus

| unde | ce spune | realitatea |
| --- | --- | --- |
| `README.md:3,38-40` + diagrama | `$share/ospp-servers/...`, „shared subscription" | abonament simplu de la `2ba00e8` |
| `README.md:41` | „bridge `BLPOP`s from `mqtt:outgoing`" | `BLMOVE`, și nu are producător |
| `REDIS-QUEUE-CONTRACT.md:75-77` | plicurile vin pe abonamentul shared | idem |
| `REDIS-QUEUE-CONTRACT.md:153` | „The bridge consumes with `BLPOP`" | `BLMOVE` — se contrazice cu `:234` din același document |
| `REDIS-QUEUE-CONTRACT.md:224-225` | „for shared subscriptions, redistributes to another group member" | exact credința pe care F-02 a infirmat-o pe fir |
| `REDIS-QUEUE-CONTRACT.md:39,267` | consumatorul folosește `BRPOP` | `BLMOVE … RIGHT LEFT` cu listă `pending` (direcția rămâne corectă) |
| `REDIS-QUEUE-CONTRACT.md:5` | „Laravel Horizon job" | comandă artisan de sine stătătoare, container propriu |
| `package.json:4` | „shared subscription" în descriere | idem |

---

## 7. Ce nu am putut stabili

- **Dacă podul rulează chiar acum în UAT și PROD.** Deploy-ul e complet cablat
  (§1.5) și a fost verificat viu în trecut — `docs/REPORT-UAT-PARITY-AUDIT-20260526…:45`
  (ambele containere pe același SHA de imagine), `REPORT-FULL-COVERAGE-RERUN-20260527…:384`
  (`csms-mqtt-bridge-prod` Up 4 zile, healthy), `AUDIT-UAT-PROD-MIRROR.md:523`. Dovezi
  indirecte recente: `KNOWN-ISSUES.md:1889-1890` („UAT lost its bridge for four days").
  Dar **niciun document din august 2026 nu afirmă că rulează**, iar eu nu am acces la
  gazde. **NESTABILIT.**
- **Valorile de mediu reale din UAT/PROD.** `.env*` sunt gitignorate; `.env.uat` din
  repo e un artefact de generator din 2026-02-24, fără `REDIS_MQTT_*` și fără
  `BRIDGE_VERSION`. Ce **se poate** deriva: `assertQueueRedisDurable()` aruncă fatal
  în `production|staging|uat` dacă politica nu e `noeviction`, deci orice mediu în
  care `mqtt-consumer` chiar rulează **trebuie** să aibă `REDIS_MQTT_HOST=redis-queue`
  — altfel workerul n-ar porni deloc. Asta e o deducție din cod, nu o măsurătoare.
- **Toate cifrele de mediu din acest raport vin de pe stiva LOCALĂ** — imaginea `0.1.5`,
  `session_expiry_interval=0`, `allkeys-lru`, cele 161 de aruncări, `ulimit -n`.
  Concluziile de cod, de contract și de test sunt independente de mediu; **cifrele
  nu sunt.** Flota de 4 stații și volumul de 2794 mesaje/28 zile sunt citate din
  `KNOWN-ISSUES.md`, nu măsurate de mine.
- **Dacă `csms_bridge_topic_drops_total` e chiar scrapat.** Ținta e configurată în
  ambele fișiere Prometheus (`prometheus.yml:38-44`, `prometheus-prod.yml:42-48`),
  alerta există (`alerts.yml:495-514`), iar `/metrics` răspunde din rețea — dar
  **Prometheus nu rulează local**, deci sănătatea scrape-ului se poate confirma doar
  pe mediul unde rulează.
- **Comentariile din `SessionEndedHandler.php:100-103` și `StopOrderInversionTest.php:50-54`.**
  Semantica Redis e măsurată și neambiguă (§2.6), dar fișierele sunt în `csms-server`,
  unde nu am scris și nu am rulat nimic. Rămâne de adjudecat acolo.
- **Comportamentul sub o pană Redis mai lungă de ~25 s** l-am extrapolat din funcția
  `retryStrategy` exportată de repo, nu l-am rulat în timp real până la capătul
  plafonului de 30 s. Pauza scurtă (10 s) e măsurată integral.

---

## 8. Metodă

Ce am rulat, ca să se poată reface sau contrazice:

| ce | cum |
| --- | --- |
| suita | `npm run test` în repo → **164 teste / 4 fișiere / 2,46 s / verde** |
| repartiția testelor | `vitest run --reporter=json`, clasificare pe numele complet al fiecărui caz |
| topologia cozilor | `redis-cli MONITOR` pe `csms-redis`, 12 s, filtrat pe IP-ul fiecărui container |
| Redis căzut | `dist/redis.js` real (reconstruit din sursa HEAD) contra unui Redis de unică folosință pe `:6399`, omorât cu `docker kill`, 500 împingeri, repornit |
| evacuare | același harnașament, `maxmemory 3mb`, o dată `noeviction`, o dată `allkeys-lru` |
| ordine | `LPUSH`/`BLMOVE RIGHT`/`RPUSH` pe Redis real, cu urmărirea listei la fiecare pas |
| debit | 3000 împingeri secvențiale prin `pushIncoming` real |
| plafoane broker | `emqx ctl clients list`, `emqx ctl listeners`, `emqx ctl conf show mqtt`, `ulimit -n` |
| pompa mqtt.js | citirea `node_modules/mqtt/build/lib/client.js:262-296` și `handlers/publish.js:87-92` |

Stiva locală **nu a fost atinsă**: proba a folosit un container Redis separat
(`audit-redis-probe`, șters la final) și un port separat. `csms-server` a fost citit
strict read-only. `dist/` e gitignorat; reconstruirea nu a murdărit arborele.

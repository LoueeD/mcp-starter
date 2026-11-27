# Free-tier notes

Cloudflare’s limits change. The figures below were checked on 27 November 2026 against Cloudflare’s Workers and Durable Objects pricing/limits pages. Confirm current numbers before depending on them.

## Workers Free

| Resource | Free allowance |
| --- | --- |
| Requests | 100,000 per day, across all Workers on the account |
| CPU time | 10 ms per invocation |
| Memory | 128 MB |
| Subrequests | 50 per invocation |
| Environment variables | 64 per Worker, 5 KB each |
| Worker size | 64 MiB |
| Workers | 100 per account |
| Static asset requests | Free and unlimited |

## Durable Objects Free

Only SQLite-backed Durable Objects are available on the Free plan.

| Resource | Free allowance |
| --- | --- |
| Requests | 100,000 per day |
| Duration | 13,000 GB-s per day |
| SQL rows read | 5 million per day |
| SQL rows written | 100,000 per day |
| SQL stored data | 5 GB per account |
| Storage per object | 1 GB on Free |
| Durable Object classes | 100 per account |

Durable Object requests include HTTP requests, RPC sessions, WebSocket messages and alarm invocations. Every RPC method call from the Worker to the account object is a separate billed request.

Rate limiting bindings do not add a separate billed product; the calls count as Worker CPU and requests. Counters are approximate and per Cloudflare location.

## What one interaction costs

A simple MCP read looks roughly like:

1. One Worker request for the MCP tool call.
2. One or more Durable Object RPC requests:
   - resolve the execution token;
   - authorize the revision;
   - run the read.
3. SQL row reads for the session/connection checks and the data page.

A write adds:

- row reads for the access check and existence check;
- one or more row writes for the mutation and revision bump;
- row reads for the read-back.

A browser login adds WebAuthn verification and several row reads/writes for the session and challenge record.

This is not a high-volume design per account. It is comfortable for a personal tool or a small team, especially with read-only connections.

## The 10 ms CPU problem

The Free plan allows 10 ms of CPU per invocation. Waiting on I/O does not count, but CPU does.

WebAuthn verification (ECDSA/RSASSA), JSON parsing and AES-GCM are all CPU work. In practice:

- Most requests are far below 10 ms.
- Passkey registration/login can occasionally exceed it, especially on a cold isolate.
- If you see **error 1102** (“Worker exceeded resource limits”) during login, move to Workers Paid.

Workers Paid starts at $5/month and includes:

- 10 million requests/month;
- 30 million CPU-ms/month;
- a 30-second default CPU limit per invocation (configurable up to 5 minutes);
- 1 million Durable Object requests/month;
- 400,000 GB-s/month;
- 25 billion row reads/month;
- 50 million row writes/month;
- 5 GB-month of SQL storage included.

For a starter used by a handful of people, the paid plan’s included usage is usually more than enough.

## Cost-control suggestions

1. **Start read-only.** Fewer writes means fewer row writes and fewer accidental upstream calls.
2. **Use one connection per client.** Revoke unused clients. The active limit is 20.
3. **Keep pages small.** The demo caps `limit` at 50. A chatty agent that requests 50 rows repeatedly costs more than one that asks for 10.
4. **Avoid polling.** MCP is request-driven; there are no background jobs or alarms in this starter.
5. **Do not add chatty health checks.** Static assets are free, but `/health` invokes the Worker. Use the Cloudflare dashboard for uptime, or check infrequently.
6. **Watch row writes.** Sign-ups, logins, connection changes and demo writes all consume row writes. A 100,000/day allowance is generous for people but not for an automated loop.
7. **Set a spending limit.** On the Paid plan, configure a Workers/Durable Objects spending limit so a bug or abuse cannot produce a surprise bill. Stored data charges are excluded and continue.
8. **Delete unused demo data.** The seed adds three notes per account. Trivial, but remove it when you replace the demo.
9. **Use a custom domain if you like.** Custom domains do not change the Workers request price.
10. **Measure before optimizing.** The Cloudflare dashboard shows requests, CPU, row reads/writes and storage per Worker/Durable Object.

## When to upgrade

Upgrade to Workers Paid if any of these apply:

- you see error 1102 during passkey ceremonies;
- you approach 100,000 requests/day;
- you need more than 100,000 Durable Object requests/day;
- you need more than 100,000 row writes/day;
- you need more than 5 GB of stored data;
- you want longer CPU limits for heavier upstream processing;
- you need a spending limit or higher Worker/class limits.

## What is not free

- Custom domains are available on the Workers Free plan, but the domain registration itself may cost money.
- Email, R2, D1, Queues, Vectorize and other products have separate limits and pricing.
- This starter intentionally uses only Workers, static assets, Durable Objects and the Rate Limiting binding.

## Rough capacity examples

These are order-of-magnitude illustrations, not guarantees:

| Usage | Likely plan |
| --- | --- |
| One person, a few reads/writes per day | Free |
| Five people, dozens of reads per day, occasional writes | Free, unless login hits the CPU limit |
| A small team using it all day, hundreds of calls per day | Free request-wise, but Paid for CPU headroom |
| An agent polling continuously or bulk-importing | Paid, and add stricter limits |
| Multi-tenant SaaS with many accounts | Paid, plus per-account quotas and monitoring |

## Checking your usage

- Workers & Pages → your Worker → Metrics: requests, errors, CPU time.
- Durable Objects → your namespace → Metrics: requests, duration, storage, rows.
- Account → Billing → Usage: plan-level totals.
- Set alerts for error rate and daily usage.

If a limit is reached, Cloudflare fails the affected operations rather than silently billing on Free. Daily limits reset at 00:00 UTC.

## References

- Workers limits: <https://developers.cloudflare.com/workers/platform/limits/>
- Workers pricing: <https://developers.cloudflare.com/workers/platform/pricing/>
- Durable Objects pricing: <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- Durable Objects limits: <https://developers.cloudflare.com/durable-objects/platform/limits/>
- Rate Limiting binding: <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>

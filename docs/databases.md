# Databases

PostgreSQL, MySQL, SQL Server, MongoDB and Redis, reached directly or through a bastion.

[← Back to the README](../README.md)

---



OpsMaxx speaks **PostgreSQL, MySQL, SQL Server, MongoDB and Redis**. Add a connection with discrete fields or a full connection string, browse tables and collections in the sidebar, and open each database in its own tab.

Every engine gets an **interactive shell** alongside the query editor:

- **MongoDB** — `show dbs`, `use x`, `db.users.find({...}).sort({...}).limit(n)`, aggregation pipelines, `ObjectId()` / `ISODate()` helpers
- **PostgreSQL / MySQL / SQL Server** — SQL plus psql-style meta commands: `\l`, `\dt`, `\d <table>`, `\du`, `\c <database>`
- **Redis** — commands passed straight through

**Databases over SSH:** pick a bastion in the *SSH tunnel* field and OpsMaxx opens a forward automatically, so you can reach a database that is only routable from inside the network.

**Databases over a VPN:** pick a WireGuard or OpenVPN profile in the *Network* field and the tunnel is brought up before the connection is attempted. A bastion and a VPN can both be set — the VPN is the outer transport, and the bastion is reached through it.

**Operating a database, not just querying it.** Beside the client there is a read of how the server itself is doing: replication lag, slow queries, table and index sizes, connection counts against the ceiling, and the locks and long transactions behind them. It covers **PostgreSQL, MySQL/MariaDB, MongoDB and Redis**; SQL Server has the client but not this, and the app says so rather than showing an empty panel.

A replica reporting zero lag is not the same as a replica that is healthy — a stopped one says zero too — so the read distinguishes "caught up" from "not replicating", which is the distinction a real dead replica taught it to make.

---

[← Back to the README](../README.md)

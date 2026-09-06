# Allocatable vs requested (roadmap item 47)

## Provenance

Recorded from a **real three-node `kind` cluster** (v1.33, one control-plane, two
workers) created for this purpose on 6 Sep and deleted afterwards. Nothing here is
reconstructed from documentation, which is the rule the parent directory sets.

| File | Command |
|---|---|
| `node-allocatable.txt` | `kubectl get nodes -o custom-columns=<ALLOC_NODE_COLS>` |
| `node-allocatable-cordoned.txt` | the same, with `sp-alloc-worker2` cordoned |
| `pod-requests.txt` | `kubectl get pods -A -o custom-columns=<ALLOC_POD_COLS>` |
| `describe-allocated.txt` | the `Allocated resources` block of `kubectl describe node`, for all three nodes |
| `k3s-single-node.txt` | the same read against a **live single-node k3s cluster on a different host** |
| `k3s-describe-allocated.txt` | that node's own `Allocated resources` block |

### The k3s pair, and the one thing altered in it

Everything above is `kind`. A parser tuned to one implementation passes its own
fixtures, so the shipped read was re-run against a live k3s on a different
distribution, with different node naming and a different set of system pods. It
agreed to the byte: **200m and 140Mi**, and the node's own printed percentages
(**3%** and **1%**) match what this computes from `6` cores and `12247552Ki` —
neither of which the kind fixture exercises, since kind reports `12` and a
different memory figure.

**PROVENANCE CAVEAT, the only one in this directory:** the node's real name was
replaced with `k3s-node-1` in both k3s files, because it identifies a live host and
this repository is public. Nothing else was altered. Every number, column, ordering
and blank line is as recorded.

k3s also supplied a second unsized system pod — `local-path-provisioner`, where kind
had `kube-proxy`. Two unrelated distributions both ship one, which is the evidence
for the rule that the unsized count is never zero on a real cluster and must not be
rendered as an anomaly.

## Why `describe-allocated.txt` exists

It is the **ground truth**: the block prints what the scheduler actually booked.
`tests/k8sAllocatable.test.ts` computes each node's requests from `pod-requests.txt`
and compares them against it, so the formula is checked against Kubernetes rather
than against the author's memory of Kubernetes. On `sp-alloc-worker2` both come to
**940m and 514Mi**.

That check is what caught the initContainer rule. Summing only the app containers
gave 440m on that node against the scheduler's 940m, and the missing 500m is
`withinit`'s init container.

## The workloads, and what each one is for

| Deployment | Shape | The case |
|---|---|---|
| `sized` ×3 | cpu + memory requests and limits | the ordinary one |
| `unbounded` ×3 | **no `resources` block at all** | `<none>` is not zero |
| `cpuonly` ×2 | cpu request, no memory request | half-specified at the pod level |
| `twocontainer` ×1 | two containers, both sized | the sum is per POD |
| `mixed` ×1 | two containers, **one sized and one not** | the column prints ONE value with no placeholder, so only the container-name count reveals it |
| `withinit` ×1 | init requests 500m, container requests 10m | `max(sum(containers), max(initContainers))` |
| `toobig` ×1 | 64 cores, 200Gi — unschedulable on purpose | Pending, `nodeName` empty, booked nowhere |

## What could not be captured

* **A node whose `.status.allocatable` is unreadable.** Every real node reports it,
  so the null path is exercised with a hand-written row, labelled as such in the test.
* **A `Succeeded`/`Failed` pod still carrying a `nodeName`.** Producing one on demand
  needs a job that exits at a controlled moment; the case is covered with a
  constructed row and it is marked CONSTRUCTED in the test rather than implied to be
  a recording.
* **`kubectl top`.** A metrics-server is not installed in `kind` by default, and this
  read does not use it — usage and booked capacity are different questions, which is
  the distinction the panel renders.

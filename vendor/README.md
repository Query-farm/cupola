# Evidence Core source package

`evidence-core-e02a067.tgz` contains the MIT-licensed `core/` source from
https://github.com/evidence-dev/evidence at commit
`e02a06719afb648c023e2678a226c0e394b075d0`.

Upstream marks this package private and does not publish an embeddable Core SDK.
This local source package makes the prototype reproducible without depending on
an external checkout. Source is unchanged; tests/fixtures are excluded. Package
metadata omits upstream devDependencies, adds the license, and pins the version
as `0.0.1-cupola.e02a067`. The archive includes the upstream MIT license.

To refresh it, run `scripts/vendor-evidence-core.sh <evidence-checkout> [commit]`,
point `@evidence/core` in `package.json` at the new archive, update this file and
run `bun install`. The archive is byte-reproducible: rebuilding the same commit gives
the same file, so `bun.lock`'s integrity hash verifies it.

The Cupola integration lives in `src/lib/evidence` and `src/components/evidence`.
This is an evaluation of an internal upstream interface, not a stable SDK contract.

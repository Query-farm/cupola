# Evidence Core source package

`evidence-core-c770bf8.tgz` contains the MIT-licensed `core/` source from
https://github.com/evidence-dev/evidence at commit
`c770bf819f5b9fe9c9845f0edf7d5e007a02223f`.

Upstream marks this package private and does not publish an embeddable Core SDK.
This local source package makes the prototype reproducible without depending on
an external checkout. Source is unchanged; tests/fixtures are excluded. Package
metadata omits upstream devDependencies, adds the license, and pins the version
as `0.0.1-cupola.c770bf8`. The archive includes the upstream MIT license.

The Cupola integration lives in `src/lib/evidence` and `src/components/evidence`.
This is an evaluation of an internal upstream interface, not a stable SDK contract.

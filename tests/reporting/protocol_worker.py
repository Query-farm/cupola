"""Isolated HTTP contract fixture using the adjacent, unreleased SDK.

This exercises browser/SDK interoperability independently of the reference
worker's migration. It is not an implementation of storage or authorization.
"""

from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from vgi.worker import Worker
from vgi_rpc.utils import deserialize_record_batch
from vgi.reporting.common import Limit, OwnerRef, Ownership, OwnershipCapabilities, PrincipalRef, ValidationResult
from vgi.reporting.discovery import DiscoveryCapabilities, OwnerDiscoveryCapabilities, validate_search
from vgi.reporting.notify import ChannelInfo, DestinationCheck, DestinationRecord, NotifyInfo, NotifyProtocol
from vgi.reporting.objects import ObjectKindInfo, ObjectSummary, ObjectsInfo, ObjectsProtocol
from vgi.reporting.ownership import OwnershipCandidate
from vgi.reporting.resource_identity import IdentityCapabilities, OwnershipCheck, ResourceIdentityProtocol
from vgi.reporting.resource_ownership import OwnershipInfo, OwnershipProtocol, OwnershipResource
from vgi.reporting.schedules_v2 import SchedulePreviewJobV2, SchedulesProtocolV2, ScheduleTestV2
from vgi_rpc.rpc import CallContext, MethodNotImplementedError, OutputCollector, ProducerState, Stream

NOW = datetime.now(timezone.utc)
POLICY = OwnershipCapabilities(owner_kinds=["principal", "group", "organization"],
    parent_owner_kinds=["organization"], scopes=["all", "self", "member", "self_or_member"],
    membership_owner_kinds=["group", "organization"])
OWNER = Ownership(owner_ref=OwnerRef(kind="group", id="tenant/groups/finance", display_name="Finance"),
    parent_owner_ref=OwnerRef(kind="organization", id="tenant/org", display_name="Example"))
ACTOR = PrincipalRef(id="tenant/users/alice", kind="user", display_name="Alice", email=None)
CAPS = OwnerDiscoveryCapabilities(policy=POLICY, search_supported=True, suggestions_supported=False,
    enumeration_supported=False, min_query_length=3, max_results=5, identifier_schemes=["group_id"], query_hint="Enter a group ID")


BATCHES: dict[str, list[bytes]] = {}


@dataclass
class Rows(ProducerState):
    key: str
    index: int = 0
    fail_at: int | None = None

    def produce(self, out: OutputCollector, ctx: CallContext) -> None:
        if self.fail_at == self.index:
            raise RuntimeError("Directory unavailable during continuation")
        if self.index >= len(BATCHES[self.key]):
            out.finish()
            return
        batch, _ = deserialize_record_batch(BATCHES[self.key][self.index])
        out.emit(batch)
        self.index += 1
        if self.index == len(BATCHES[self.key]):
            out.finish()


def stream(record, rows, fail_at=None):
    key = str(uuid4())
    BATCHES[key] = [row.serialize_to_bytes() for row in rows]
    return Stream(output_schema=record.ARROW_SCHEMA, state=Rows(key=key, fail_at=fail_at))


class Notifications(NotifyProtocol):
    def get_notify_info(self):
        return NotifyInfo(protocol_version="1.0.0", display_name="Contract fixture", writable=True,
            limits=[Limit(name="max_check_destinations", value=2, unit="count"), Limit(name="max_send_destinations", value=10, unit="count")],
            channels=[ChannelInfo(kind="email", enabled=True, images=False, threads=False, limits=[], html_body=True,
                discovery=DiscoveryCapabilities(search_supported=True, min_query_length=3, max_results=5))], destination_policy_summary="Exact checks only")

    def find_destinations(self, kind, query, limit=20) -> Stream[Rows]:
        validate_search(query, limit, self.get_notify_info().channels[0].discovery)
        return stream(DestinationRecord, [DestinationRecord(kind=kind, address=f"reader-{i}@example.test", display_name=None) for i in range(limit)])

    def list_destinations(self, kind, limit=None) -> Stream[Rows]:
        raise MethodNotImplementedError("Directory enumeration is disabled")

    def check_destinations(self, destinations) -> Stream[Rows]:
        if len(destinations) > 2:
            raise ValueError("max_check_destinations exceeded")
        checks = [DestinationCheck(kind=d.kind, address=d.address, display_name=None, input_index=i,
            state="unknown" if d.address.startswith("unknown") else "allowed", reason_code=None, reason=None)
            for i, d in reversed(list(enumerate(destinations)))]
        return stream(DestinationCheck, checks, fail_at=1 if any(d.address.startswith("fail") for d in destinations) else None)


class Identities(ResourceIdentityProtocol):
    def get_identity_capabilities(self, context):
        assert context.protocol == "vgi.objects.v1" and context.resource_kind == "object"
        return IdentityCapabilities(ownership=CAPS, execution=None)

    def find_owners(self, context, query, limit=20) -> Stream[Rows]:
        validate_search(query, limit, CAPS)
        return stream(OwnershipCandidate, [OwnershipCandidate(label="Finance", description="Enterprise team", ownership=OWNER)])

    def check_ownership(self, context, owner=None, parent=None):
        assert context.operation == "transfer_ownership" and context.resource_id == "object-0" and context.parent_folder_id is None
        allowed = owner is not None and owner.scheme == "group_id" and owner.value == OWNER.owner_ref.id
        return OwnershipCheck(state="allowed" if allowed else "unknown", ownership=OWNER if allowed else None, reason_code=None, message=None)


class Owners(OwnershipProtocol):
    def get_ownership_info(self):
        return OwnershipInfo(resources=[OwnershipResource(protocol="vgi.objects.v1", resource_kind="object")])

    def get_ownership_capabilities(self, protocol, resource_kind, resource_id):
        assert protocol == "vgi.objects.v1" and resource_kind == "object"
        return CAPS

    def find_owners(self, protocol, resource_kind, resource_id, query="", limit=20) -> Stream[Rows]:
        validate_search(query, limit, CAPS)
        return stream(OwnershipCandidate, [OwnershipCandidate(label="Finance", description="Enterprise team", ownership=OWNER)])


class Objects(ObjectsProtocol):
    def get_objects_info(self):
        return ObjectsInfo(protocol_version="1.0.0", display_name="Contract library", writable=True, limits=[], ownership=POLICY,
            kinds=[ObjectKindInfo(kind="report", body_formats=["cupola.evidence/1"])], root_allowed_actions=["read"], creatable_kinds=[])

    def list_objects(self, query="", folder_id=None, recursive=False, tags=None, ownership_scope="all", published_only=False,
            object_kind="", owner=None, parent_owner=None, limit=None, order_by="") -> Stream[Rows]:
        assert ownership_scope in POLICY.scopes
        rows = [ObjectSummary(version=9223372036854775806, ownership=OWNER, created_at=NOW, created_by=ACTOR,
            updated_at=NOW, updated_by=ACTOR, allowed_actions=["read", "transfer_ownership"], object_id=f"object-{i}",
            object_kind="report", folder_id=folder_id, title=f"Finance {i} " + "x" * 1000, body_format="cupola.evidence/1",
            revision_served=f"revision-{i}", body_sha256=None, redacted=False) for i in range(min(limit or 100, 200))]
        return stream(ObjectSummary, rows)


class Schedules(SchedulesProtocolV2):
    def __init__(self):
        self.jobs = {}

    def validate_schedule(self, schedule, execution=None):
        assert schedule.action.render_report.source.object_id == "report"
        return ValidationResult(valid=True, complete=True, issues=[])

    def start_test_run(self, request_id, schedule, *, execution=None, as_of):
        assert schedule.action.render_report.source.object_id == "report"
        if request_id not in self.jobs:
            self.jobs[request_id] = SchedulePreviewJobV2(job_id=request_id, version=1, status="queued", created_at=NOW,
                finished_at=None, poll_after_seconds=0, expires_at=NOW + timedelta(hours=1), error=None, allowed_actions=["cancel"], result=None)
        return self.jobs[request_id]

    def get_test_run(self, job_id):
        job = self.jobs[job_id]
        if job.status not in ("cancelled", "succeeded"):
            job = replace(job, status="succeeded", version=2, finished_at=NOW, allowed_actions=[],
                result=ScheduleTestV2(evaluated_at=NOW, parameter_values=[], condition_value=None, condition_evaluated=False, outputs=[], messages=[], ))
            self.jobs[job_id] = job
        return job

    def cancel_test_run(self, job_id, expected_version, request_id):
        job = self.jobs[job_id]
        assert job.version == expected_version
        self.jobs[job_id] = replace(job, status="cancelled", version=job.version + 1, finished_at=NOW, allowed_actions=[])
        return self.jobs[job_id]


class ContractWorker(Worker):
    functions = []

    @classmethod
    def hosted_protocols(cls):
        return [(NotifyProtocol, Notifications()), (ResourceIdentityProtocol, Identities()), (OwnershipProtocol, Owners()),
            (ObjectsProtocol, Objects()), (SchedulesProtocolV2, Schedules())]


if __name__ == "__main__":
    ContractWorker.main()

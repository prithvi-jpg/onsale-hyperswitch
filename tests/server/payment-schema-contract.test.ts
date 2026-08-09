import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

const inventoryMigrationUrl = new URL(
  "../../db/migrations/0001_inventory_v1.sql",
  import.meta.url,
)
const paymentMigrationUrl = new URL(
  "../../db/migrations/0002_payment_fulfillment_v1.sql",
  import.meta.url,
)

describe("C3 payment and fulfillment schema contract", () => {
  it("C3-MIG-01 preserves the exact inventory migration", async () => {
    const migration = await readFile(inventoryMigrationUrl, "utf8")

    expect(createHash("sha256").update(migration).digest("hex")).toBe(
      "622c17491da6aa4458d9a81ec19ce71b5421da7e3679f79ea5e1425f73453a1a",
    )
  })

  it("C3-MIG-02 fails before additive DDL when 0001 already contains a fulfilled order", async () => {
    const migration = await readFile(paymentMigrationUrl, "utf8")
    const preflightIndex = migration.indexOf(
      "preflight_no_legacy_fulfilled_orders",
    )
    const firstAdditiveDdlIndex = migration.indexOf(
      "alter table __ONSALE_SCHEMA__.order_item",
    )

    expect(preflightIndex).toBeGreaterThanOrEqual(0)
    expect(firstAdditiveDdlIndex).toBeGreaterThan(preflightIndex)
    expect(migration).toMatch(
      /preflight_no_legacy_fulfilled_orders[\s\S]*lock table __ONSALE_SCHEMA__\.orders in share row exclusive mode[\s\S]*exists \(/iu,
    )
    expect(migration).toMatch(
      /preflight_no_legacy_fulfilled_orders[\s\S]*exists \([\s\S]*from __ONSALE_SCHEMA__\.orders[\s\S]*where state = 'fulfilled'[\s\S]*raise exception 'cannot establish payment proof for a pre-existing fulfilled order'/iu,
    )
  })

  it("C3-DB-01 adds only the normalized payment and fulfillment tables", async () => {
    const migration = await readFile(paymentMigrationUrl, "utf8")

    for (const table of [
      "provider_payment",
      "checkout_operation",
      "payment_observation",
      "payment_attempt",
      "payment_attempt_observation",
      "fulfillment_bundle",
      "ticket",
    ]) {
      expect(migration).toContain(`create table __ONSALE_SCHEMA__.${table}`)
    }
    expect(migration).not.toMatch(/\bjsonb?\b/iu)
    expect(migration).not.toMatch(/\bdrop\s+(?:schema|table)\b/iu)
    expect(migration).toMatch(
      /order_item_identity_order_seat_unique\s+unique \(id, order_id, seat_id\)/u,
    )
  })

  it("C3-DB-02 encodes stable identity, hashes, idempotency, and distinct method/connector facts", async () => {
    const migration = await readFile(paymentMigrationUrl, "utf8")

    expect(migration).toContain("unique (order_id)")
    expect(migration).toContain(
      "unique (provider, environment, provider_payment_ref)",
    )
    expect(migration).toContain("operation_key uuid not null unique")
    expect(migration).toMatch(
      /request_hash text not null[\s\S]*request_hash ~ '\^\[0-9a-f\]\{64\}\$'/u,
    )
    expect(migration).toContain("provider_attempt_ref_digest")
    expect(migration).toContain(
      "unique (payment_id, provider_attempt_ref_digest)",
    )
    expect(migration).toContain("selected_payment_method")
    expect(migration).toContain("observed_connector")
  })

  it("C3-DB-03 makes observations append-only and terminal payment state monotonic", async () => {
    const migration = await readFile(paymentMigrationUrl, "utf8")

    expect(migration).toContain("reject_payment_append_only_mutation")
    expect(migration).toContain(
      "payment_observation_append_only_before_update_or_delete",
    )
    expect(migration).toContain(
      "payment_attempt_observation_append_only_before_update_or_delete",
    )
    expect(migration).toContain("guard_provider_payment_mutation")
    expect(migration).toMatch(
      /old\.canonical_state in \('failed', 'succeeded'\)[\s\S]*new\.canonical_state <> old\.canonical_state/iu,
    )
    expect(migration).toMatch(
      /old\.create_state in \('created', 'rejected'\)[\s\S]*new\.create_state <> old\.create_state/iu,
    )
    expect(migration).toMatch(
      /old\.integrity_state = 'review_required'[\s\S]*new\.integrity_state <> 'review_required'/iu,
    )
  })

  it("C3-DB-04 locks and validates the immutable order before allocating a provider payment", async () => {
    const migration = await readFile(paymentMigrationUrl, "utf8")

    expect(migration).toContain("validate_provider_payment_insert")
    expect(migration).toMatch(
      /select \* into locked_order[\s\S]*from __ONSALE_SCHEMA__\.orders[\s\S]*where id = new\.order_id[\s\S]*for update/iu,
    )
    expect(migration).toMatch(/locked_order\.state <> 'awaiting_payment'/iu)
    for (const equality of [
      "new.dataset_id is distinct from locked_order.dataset_id",
      "new.event_id is distinct from locked_order.event_id",
      "new.amount_minor is distinct from locked_order.total_minor",
      "new.currency is distinct from locked_order.currency",
    ]) {
      expect(migration).toContain(equality)
    }
    expect(migration).toMatch(
      /create trigger provider_payment_validate_before_insert[\s\S]*before insert on __ONSALE_SCHEMA__\.provider_payment/iu,
    )
  })

  it("C3-DB-05 permits only the forward order graph and freezes order headers and terminal fulfillment", async () => {
    const migration = await readFile(paymentMigrationUrl, "utf8")

    expect(migration).toContain("guard_order_payment_transition")
    for (const edge of [
      "old.state = 'awaiting_payment' and new.state = 'payment_pending'",
      "old.state = 'awaiting_payment' and new.state = 'canceled'",
      "old.state = 'payment_pending' and new.state = 'paid'",
      "old.state = 'paid' and new.state = 'fulfilled'",
    ]) {
      expect(migration).toContain(edge)
    }
    for (const column of [
      "id",
      "dataset_id",
      "event_id",
      "hold_id",
      "sale_window_id",
      "buyer_ref",
      "currency",
      "subtotal_minor",
      "fee_minor",
      "tax_minor",
      "total_minor",
      "payment_deadline_at",
      "created_at",
    ]) {
      expect(migration).toContain(
        `new.${column} is distinct from old.${column}`,
      )
    }
    expect(migration).toContain("new.version < old.version")
    expect(migration).toMatch(
      /new\.state is distinct from old\.state[\s\S]*new\.version <= old\.version/iu,
    )
    expect(migration).toMatch(
      /new\.canceled_at is distinct from old\.canceled_at[\s\S]*old\.state = 'awaiting_payment'[\s\S]*new\.state = 'canceled'[\s\S]*old\.canceled_at is null[\s\S]*new\.canceled_at is not null/iu,
    )
    expect(migration).toMatch(
      /old\.state in \('canceled', 'fulfilled'\)[\s\S]*new is distinct from old/iu,
    )
    expect(migration).toMatch(
      /create trigger order_payment_transition_guard[\s\S]*before update on __ONSALE_SCHEMA__\.orders/iu,
    )
  })

  it("C3-DB-06 explicitly rejects deletion of payment identities, operations, and attempts", async () => {
    const migration = await readFile(paymentMigrationUrl, "utf8")

    expect(migration).toContain("reject_payment_core_delete")
    for (const [trigger, table] of [
      ["provider_payment_delete_guard", "provider_payment"],
      ["checkout_operation_delete_guard", "checkout_operation"],
      ["payment_attempt_delete_guard", "payment_attempt"],
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `create trigger ${trigger}[\\s\\S]*before delete on __ONSALE_SCHEMA__\\.${table}`,
          "iu",
        ),
      )
    }
  })

  it("C3-DB-07 freezes terminal payment proof and makes attempt observation time monotonic", async () => {
    const migration = await readFile(paymentMigrationUrl, "utf8")

    expect(migration).toMatch(
      /old\.canonical_state in \('failed', 'succeeded'\)[\s\S]*new\.successful_attempt_id is distinct from old\.successful_attempt_id[\s\S]*new\.failed_at is distinct from old\.failed_at[\s\S]*new\.succeeded_at is distinct from old\.succeeded_at/iu,
    )
    expect(migration).toContain("new.updated_at < old.updated_at")
    expect(migration).toMatch(
      /new is distinct from old[\s\S]*new\.version <= old\.version/iu,
    )
    expect(migration).toMatch(/new\.last_observed_at < old\.last_observed_at/iu)
    expect(migration).toMatch(
      /old\.canonical_state in \('hard_decline', 'technical_failure', 'succeeded'\)[\s\S]*new\.observed_connector is distinct from old\.observed_connector[\s\S]*new\.terminal_at is distinct from old\.terminal_at/iu,
    )
  })

  it("C3-FUL-01 enforces one immutable complete ticket set per order", async () => {
    const migration = await readFile(paymentMigrationUrl, "utf8")

    expect(migration).toContain("fulfillment_bundle_order_unique")
    expect(migration).toContain("fulfillment_bundle_payment_unique")
    expect(migration).toContain("ticket_order_item_unique")
    expect(migration).toContain("ticket_order_seat_unique")
    expect(migration).toContain("reject_issued_artifact_mutation")
    expect(migration).toContain("assert_fulfillment_bundle_complete")
    expect(migration).toMatch(
      /create constraint trigger fulfillment_bundle_complete_after_bundle[\s\S]*deferrable initially deferred/iu,
    )
    expect(migration).toMatch(
      /create constraint trigger fulfillment_bundle_complete_after_ticket[\s\S]*deferrable initially deferred/iu,
    )
    expect(migration).toMatch(
      /create constraint trigger fulfillment_bundle_complete_after_order[\s\S]*deferrable initially deferred/iu,
    )
    expect(migration).toMatch(
      /create constraint trigger fulfillment_bundle_complete_after_order[\s\S]*after insert or update on __ONSALE_SCHEMA__\.orders/iu,
    )
    expect(migration).toContain("fulfilled order has no fulfillment bundle")
    expect(migration).toContain("ticket_count <> item_count")
    expect(migration).toContain("succeeded_attempt_count <> 1")
  })

  it("C3-FUL-02 requires an authoritative retrieve or verified-webhook success linked to the successful attempt", async () => {
    const migration = await readFile(paymentMigrationUrl, "utf8")

    expect(migration).toMatch(
      /from __ONSALE_SCHEMA__\.payment_observation as po[\s\S]*join __ONSALE_SCHEMA__\.payment_attempt_observation as pao[\s\S]*pao\.payment_observation_id = po\.id[\s\S]*pao\.payment_id = po\.payment_id/iu,
    )
    expect(migration).toContain(
      "po.source in ('retrieve_response', 'verified_webhook')",
    )
    expect(migration).toContain("po.canonical_state = 'succeeded'")
    expect(migration).toContain("po.observed_amount_minor = payment_total")
    expect(migration).toContain("po.observed_currency = payment_currency")
    expect(migration).toContain("po.charged_attempt_count = 1")
    expect(migration).toContain(
      "pao.payment_attempt_id = successful_attempt_id",
    )
    expect(migration).toContain("pao.canonical_state = 'succeeded'")
    expect(migration).not.toMatch(
      /po\.source in \([^)]*create_response[^)]*\)/iu,
    )
  })

  it("C3-FUL-03 requires exact reserved seat-allocation coverage and preserves it after issue", async () => {
    const migration = await readFile(paymentMigrationUrl, "utf8")

    expect(migration).toContain("reserved_allocation_count")
    expect(migration).toContain("covered_allocation_count")
    expect(migration).toMatch(
      /from __ONSALE_SCHEMA__\.seat_allocation[\s\S]*order_id = checked_order_id[\s\S]*state = 'reserved'/iu,
    )
    expect(migration).toMatch(
      /from __ONSALE_SCHEMA__\.order_item as oi[\s\S]*join __ONSALE_SCHEMA__\.seat_allocation as sa[\s\S]*sa\.id = oi\.seat_allocation_id[\s\S]*sa\.order_id = oi\.order_id[\s\S]*sa\.seat_id = oi\.seat_id[\s\S]*sa\.event_id = oi\.event_id[\s\S]*sa\.dataset_id = oi\.dataset_id[\s\S]*sa\.state = 'reserved'/iu,
    )
    expect(migration).toContain("reserved_allocation_count <> item_count")
    expect(migration).toContain("covered_allocation_count <> item_count")
    expect(migration).toContain("guard_issued_seat_allocation_mutation")
    expect(migration).toMatch(
      /old_order_id := old\.order_id[\s\S]*new_order_id := new\.order_id/iu,
    )
    expect(migration).toMatch(
      /select distinct candidate_order_id[\s\S]*unnest\(array\[old_order_id, new_order_id\]\)[\s\S]*candidate_order_id is not null[\s\S]*order by candidate_order_id[\s\S]*perform 1[\s\S]*from __ONSALE_SCHEMA__\.orders[\s\S]*where id = checked_order_id[\s\S]*for update[\s\S]*end loop;[\s\S]*from __ONSALE_SCHEMA__\.fulfillment_bundle/iu,
    )
    expect(migration).toMatch(
      /create trigger issued_seat_allocation_mutation_guard[\s\S]*before insert or update or delete on __ONSALE_SCHEMA__\.seat_allocation/iu,
    )
  })

  it("C3-PAY-05 prevents cancellation after a payment identity is allocated", async () => {
    const migration = await readFile(paymentMigrationUrl, "utf8")

    expect(migration).toContain("guard_order_cancellation_after_payment")
    expect(migration).toMatch(
      /new\.state = 'canceled'[\s\S]*old\.state <> 'canceled'[\s\S]*exists \([\s\S]*from __ONSALE_SCHEMA__\.provider_payment[\s\S]*where order_id = old\.id/iu,
    )
    expect(migration).toMatch(
      /create trigger order_cancellation_after_payment_guard[\s\S]*before update on __ONSALE_SCHEMA__\.orders/iu,
    )
    expect(migration).toContain("using errcode = '55000'")
  })

  it("C3-SEC-01 has no durable field for checkout credentials or raw payment material", async () => {
    const migration = await readFile(paymentMigrationUrl, "utf8")
    const forbiddenColumn =
      /^\s*(?:client_secret|publishable_key|pan|card_number|cvc|cvv|redirect_url|redirect_body|raw_payload|provider_payload)\s+/imu

    expect(migration).not.toMatch(forbiddenColumn)
  })
})

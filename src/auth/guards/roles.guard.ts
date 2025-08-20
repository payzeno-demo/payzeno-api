/**
 * RolesGuard — the merchant's own role hierarchy, `owner ⊃ admin ⊃ developer ⊃ viewer`.
 *
 * Runs after the auth guard, so a principal is already attached. It only has an opinion about
 * `dashboard_session` principals:
 *
 *   api_key        → scopes decide, and ApiKeyGuard already checked them. A key is not a
 *                    person and has no role.
 *   staff_session  → StaffGuard decides. A Payzeno operator outranks every merchant role by
 *                    construction, and making `staff` pass a merchant role check would mean
 *                    inventing a merchant role for them.
 *   client_secret  → never. Nothing role-gated is reachable with a browser credential.
 *
 * Sites: POST/DELETE /v1/api-keys, POST /v1/bank-accounts, POST /v1/webhook_endpoints,

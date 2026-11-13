"""User directory operations, shared by the generated contract and its incremental update."""


def extend_users(paths, schemas):
    def ref(name): return {"$ref": "#/components/schemas/" + name}
    def obj(properties): return {"type": "object", "additionalProperties": False, "properties": properties, "required": list(properties)}
    string = {"type": "string"}
    roles = {"type": "array", "items": string, "minItems": 1, "maxItems": 9, "uniqueItems": True}
    profile = {"displayName": {"type": "string", "minLength": 1, "maxLength": 160}, "email": {"type": "string", "format": "email", "maxLength": 254}, "roles": roles}
    reason = {"type": "string", "minLength": 1, "maxLength": 600}
    revision = {"type": "integer", "minimum": 1}
    subject = {"type": "string", "minLength": 1, "maxLength": 255}
    timestamp = {"type": "string", "format": "date-time"}
    schemas["PlatformUser"] = obj({"userId": {"type": "string", "format": "uuid"}, "subjectId": subject, **profile, "revision": revision, "createdAt": timestamp, "updatedAt": timestamp, "updatedBy": string})
    schemas["CreatePlatformUser"] = obj({"directoryUserId": {"type": "string", "format": "uuid"}, "roles": roles, "reason": reason})
    schemas["UpdatePlatformUser"] = obj({**profile, "expectedRevision": revision, "reason": reason})
    schemas["PlatformRole"] = obj({"id": string, "name": string, "description": string, "actions": {"type": "array", "items": string}})
    schemas["IdentityDirectoryConfiguration"] = obj({"provider": {"enum": ["entra", None]}, "label": string, "configured": {"type": "boolean"}, "reason": {"type": ["string", "null"]}})
    schemas["IdentityDirectoryUser"] = obj({"id": {"type": "string", "format": "uuid"}, "displayName": string, "email": {"type": ["string", "null"]}, "principalName": string, "enabled": {"type": "boolean"}, "alreadyAdded": {"type": "boolean"}})
    schemas["IdentityDirectorySearchResults"] = obj({"items": {"type": "array", "items": ref("IdentityDirectoryUser")}, "hasMore": {"type": "boolean"}})
    for kind in ["User", "Role"]:
        schemas["Platform" + kind + "Page"] = obj({"items": {"type": "array", "items": ref("Platform" + kind)}, "nextCursor": {"type": "null"}, "generatedAt": timestamp})
    def operation(method, path, operation_id, response, summary, body=None):
        mutation = method != "GET"
        result = {"tags": ["Admin"], "summary": summary, "operationId": operation_id,
                  "x-upstream": {"service": "control-api", "method": method, "path": path.replace("{userId}", ":userId")},
                  "x-action": "admin.write" if mutation else "admin.read", "x-screens": ["PLT-19"],
                  "responses": {"201" if method == "POST" else "200": {"description": summary, "content": {"application/json": {"schema": ref(response)}}}}}
        for status, name in [(400, "BadRequest"), (401, "Unauthenticated"), (403, "Forbidden"), (404, "NotFound"), (409, "Conflict"), (429, "RateLimited"), (502, "Upstream"), (503, "Unavailable")]:
            result["responses"][str(status)] = {"$ref": "#/components/responses/" + name}
        if mutation:
            result["security"] = [{"session": [], "csrf": []}]
            result["requestBody"] = {"required": True, "content": {"application/json": {"schema": ref(body)}}}
        else:
            result["x-poll"] = {"intervalMs": 30000, "pauseWhenHidden": True, "keepLastGoodOnError": True}
        if "{userId}" in path:
            result["parameters"] = [{"name": "userId", "in": "path", "required": True, "schema": {"type": "string", "format": "uuid"}}]
        paths.setdefault(path, {})[method.lower()] = result
    operation("GET", "/v1/admin/users", "getAdminUsers", "PlatformUserPage", "List application users")
    operation("GET", "/v1/admin/roles", "getAdminRoles", "PlatformRolePage", "List assignable roles and permissions")
    operation("POST", "/v1/admin/users", "postAdminUsers", "PlatformUser", "Add an application user", "CreatePlatformUser")
    operation("PUT", "/v1/admin/users/{userId}", "putAdminUsersUserId", "PlatformUser", "Update a user and their roles", "UpdatePlatformUser")
    operation("GET", "/v1/admin/identity-provider", "getAdminIdentityProvider", "IdentityDirectoryConfiguration", "Get identity-provider directory configuration")
    operation("GET", "/v1/admin/identity-provider/users", "getAdminIdentityProviderUsers", "IdentityDirectorySearchResults", "Search identity-provider users")
    for path in ["/v1/admin/identity-provider", "/v1/admin/identity-provider/users"]:
        paths[path]["get"]["x-upstream"] = {"service": "experience-bff", "note": "Read-only directory lookup through the configured identity provider"}
        del paths[path]["get"]["x-poll"]
    paths["/v1/admin/identity-provider/users"]["get"]["x-action"] = "admin.write"
    paths["/v1/admin/identity-provider/users"]["get"]["parameters"] = [{"name": "query", "in": "query", "required": True, "schema": {"type": "string", "minLength": 2, "maxLength": 100}}]

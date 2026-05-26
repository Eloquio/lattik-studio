# Vercel's OIDC issuer in team-mode. One issuer per team — the path segment
# is the team slug. Lattik Studio's role trusts this provider and gates on
# the `sub` and `aud` claims so only this project's deployments (in the
# configured environment) can assume the role.
#
# The thumbprint is required by IAM but is no longer validated for OIDC
# providers backed by publicly-trusted CAs (Vercel uses a Let's Encrypt
# certificate). The dummy value below satisfies the API.
resource "aws_iam_openid_connect_provider" "vercel" {
  url             = "https://oidc.vercel.com/${var.vercel_team_slug}"
  client_id_list  = [local.vercel_aud]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

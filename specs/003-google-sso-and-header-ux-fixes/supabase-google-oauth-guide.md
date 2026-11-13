# Supabase Cloud Dashboard: Google OAuth Provider Activation Guide

To resolve the Google SSO 400 error (`Unsupported provider: provider is not enabled`) on project `unzffihtqdqgqbgnwokj`:

### Step 1: Access Supabase Dashboard
1. Open [https://supabase.com/dashboard/project/unzffihtqdqgqbgnwokj/auth/providers](https://supabase.com/dashboard/project/unzffihtqdqgqbgnwokj/auth/providers)
2. Locate **Google** in the Auth Providers list.

### Step 2: Configure Credentials
1. Toggle **Enable Sign in with Google** to **ON**.
2. Paste the credentials from your Google Cloud Console (`Web client 1`):
   - **Client ID**: `403482594252-r2415175l35c87l85e9m42j1t1j3c2d6.apps.googleusercontent.com`
   - **Client Secret**: *(your Google OAuth client secret)*
3. Confirm Authorized Redirect URI matches:
   `https://unzffihtqdqgqbgnwokj.supabase.co/auth/v1/callback`

### Step 3: Save & Verify
1. Click **Save**.
2. Storefront Google Sign In will now redirect cleanly to Google Account Selection and complete callback with state verification.

#!/usr/bin/env python3
import os
import re
import sys

def configure_signing():
    pbxproj_path = "App.xcodeproj/project.pbxproj"
    if not os.path.exists(pbxproj_path):
        print(f"Error: {pbxproj_path} not found!", file=sys.stderr)
        sys.exit(1)

    team_id = os.environ.get("DEVELOPMENT_TEAM", "")
    profile_name = os.environ.get("PROFILE_NAME", "")
    bundle_id = os.environ.get("BUNDLE_ID", "com.huyfnb.app")

    print(f"Configuring iOS Signing for Target App:")
    print(f"  Team ID: {team_id}")
    print(f"  Profile Name: {profile_name}")
    print(f"  Bundle ID: {bundle_id}")

    with open(pbxproj_path, "r", encoding="utf-8") as f:
        content = f.read()

    # 1. Update App target Release (ID: 504EC3181FED79650016851F)
    target_pattern = r'(504EC3181FED79650016851F /\* Release \*/ = \{[\s\S]*?buildSettings = \{)([\s\S]*?)(\};\s*name = Release;)'
    def repl_target(m):
        header, settings, footer = m.group(1), m.group(2), m.group(3)
        settings = re.sub(r'CODE_SIGN_STYLE\s*=\s*[^;]+;\n?', '', settings)
        settings = re.sub(r'DEVELOPMENT_TEAM\s*=\s*[^;]+;\n?', '', settings)
        settings = re.sub(r'PROVISIONING_PROFILE_SPECIFIER\s*=\s*[^;]+;\n?', '', settings)
        settings = re.sub(r'CODE_SIGN_IDENTITY\s*=\s*[^;]+;\n?', '', settings)
        settings = re.sub(r'PRODUCT_BUNDLE_IDENTIFIER\s*=\s*[^;]+;\n?', '', settings)
        new_settings = (
            f'\n\t\t\t\tCODE_SIGN_IDENTITY = "Apple Distribution";'
            f'\n\t\t\t\tCODE_SIGN_STYLE = Manual;'
            f'\n\t\t\t\tDEVELOPMENT_TEAM = {team_id};'
            f'\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = {bundle_id};'
            f'\n\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "{profile_name}";'
        ) + settings
        return header + new_settings + footer

    content, n1 = re.subn(target_pattern, repl_target, content)
    if n1 == 0:
        print("Warning: Target Release configuration not matched in pbxproj!")

    # 2. Update Project-level Release (ID: 504EC3151FED79650016851F)
    proj_pattern = r'(504EC3151FED79650016851F /\* Release \*/ = \{[\s\S]*?buildSettings = \{)([\s\S]*?)(\};\s*name = Release;)'
    def repl_proj(m):
        header, settings, footer = m.group(1), m.group(2), m.group(3)
        settings = re.sub(r'DEVELOPMENT_TEAM\s*=\s*[^;]+;\n?', '', settings)
        settings = re.sub(r'CODE_SIGN_IDENTITY\s*=\s*[^;]+;\n?', '', settings)
        new_settings = (
            f'\n\t\t\t\tCODE_SIGN_IDENTITY = "Apple Distribution";'
            f'\n\t\t\t\tDEVELOPMENT_TEAM = {team_id};'
        ) + settings
        return header + new_settings + footer

    content, n2 = re.subn(proj_pattern, repl_proj, content)
    if n2 == 0:
        print("Warning: Project Release configuration not matched in pbxproj!")

    with open(pbxproj_path, "w", encoding="utf-8") as f:
        f.write(content)

    print("Success: App.xcodeproj/project.pbxproj configured for manual signing.")

if __name__ == "__main__":
    configure_signing()

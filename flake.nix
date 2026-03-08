{
  inputs = {
    nixpkgs.url = "github:cachix/devenv-nixpkgs/rolling";
    systems.url = "github:nix-systems/default";
    devenv.url = "github:cachix/devenv";
    devenv.inputs.nixpkgs.follows = "nixpkgs";
  };

  nixConfig = {
    extra-trusted-public-keys = "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=";
    extra-substituters = "https://devenv.cachix.org";
  };

  outputs = { self, nixpkgs, devenv, systems, ... } @ inputs:
    let
      forEachSystem = nixpkgs.lib.genAttrs (import systems);

      # ── Version ──────────────────────────────────────────────────────────────
      # Bump this and update `hash` below whenever a new release is cut.
      appVersion = "3.0.5";

      # ── Production package builder ───────────────────────────────────────────
      # Wraps the pre-built x86_64 Linux AppImage for NixOS compatibility.
      # Only usable on Linux; `packages.${system}.default` is only set when
      # `pkgs.stdenv.isLinux` is true.
      mkOgiPackage = pkgs:
        pkgs.appimageTools.wrapType2 {
          pname = "opengameinstaller";
          version = appVersion;
          src = pkgs.fetchurl {
            url = "https://github.com/Nat3z/OpenGameInstaller/releases/download/v${appVersion}/OpenGameInstaller-linux-pt.AppImage";
            # After bumping appVersion, obtain the correct hash with:
            #   nix store prefetch-file --hash-type sha256 <url>
            # or simply run `nix build` — Nix will print the right hash.
            hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
          };
          # Make the system umu-run visible inside the AppImage sandbox so OGI's
          # NixOS detection can find it without downloading a bundled copy.
          extraPkgs = pkgs: [ pkgs.umu-launcher pkgs.bun ];
        };
    in
    {
      # ── Production packages ──────────────────────────────────────────────────
      # `nix build` / `nix profile install` on Linux:
      #   nix build github:Nat3z/OpenGameInstaller
      packages = forEachSystem (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in {
          # devenv helpers (kept from the original flake)
          devenv-up   = self.devShells.${system}.default.config.procfileScript;
          devenv-test = self.devShells.${system}.default.config.test;
        } // nixpkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
          default = mkOgiPackage pkgs;
        }
      );

      # ── nix run ──────────────────────────────────────────────────────────────
      # Launch without installing:
      #   nix run github:Nat3z/OpenGameInstaller
      apps = forEachSystem (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in nixpkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
          default = {
            type    = "app";
            program = "${self.packages.${system}.default}/bin/opengameinstaller";
          };
        }
      );

      # ── NixOS module ─────────────────────────────────────────────────────────
      # Add to your NixOS configuration:
      #
      #   inputs.opengameinstaller.url = "github:Nat3z/OpenGameInstaller";
      #
      #   { inputs, ... }: {
      #     imports = [ inputs.opengameinstaller.nixosModules.default ];
      #     programs.opengameinstaller.enable = true;
      #   }
      nixosModules.default = { config, pkgs, lib, ... }: {
        options.programs.opengameinstaller.enable =
          lib.mkEnableOption "OpenGameInstaller — open-source game installer and launcher";

        config = lib.mkIf config.programs.opengameinstaller.enable {
          environment.systemPackages = [
            (mkOgiPackage pkgs)
            # umu-launcher is used directly by OGI on NixOS for Wine/Proton
            # compatibility; declaring it here ensures it survives GC.
            pkgs.umu-launcher
            # bun is required at runtime for OGI's JS execution layer
            pkgs.bun
          ];
        };
      };

      # ── Development shells ───────────────────────────────────────────────────
      # Enter with:  nix develop
      devShells = forEachSystem (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = devenv.lib.mkShell {
            inherit inputs pkgs;
            modules = [
              {
                # https://devenv.sh/reference/options/
                packages = with pkgs; [
                  # Runtime deps mirroring what production users need
                  electron
                  bun
                  git
                  libglibutil # provides GLib utilities required by Electron's GLib bindings at runtime

                  # Wine for running Windows redistributables
                  wineWowPackages.stable

                  # SteamTinkerLaunch (reference only — Add to Steam is
                  # disabled on NixOS, but useful for dev investigation)
                  steamtinkerlaunch

                  # UMU launcher — OGI prefers the system binary on NixOS
                  umu-launcher

                  # Native build toolchain
                  pkg-config
                  gcc
                ];

                enterShell = ''
                  echo "OpenGameInstaller dev shell (v${appVersion})"
                  echo "  bun:     $(bun --version)"
                  echo "  git:     $(git --version)"
                  echo "  umu-run: $(which umu-run 2>/dev/null || echo 'not found')"
                  echo "  wine:    $(wine --version 2>/dev/null || echo 'not found')"
                  echo ""
                  echo "NixOS: 'Add to Steam' is disabled; use umu-run for compatibility."
                '';

                env.ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron}/bin/";
              }
            ];
          };
        }
      );
    };
}

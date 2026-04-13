{
  description = "Panda Harness personal Pi config repo";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);
    in {
      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [
              biome
              git
              nodejs_22
              pnpm
              typescript
            ];

            shellHook = ''
              echo "Panda Harness dev shell"
              echo "Run pnpm install once, then use pnpm test:extensions or pnpm lint:typecheck"
            '';
          };
        });
    };
}

{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShell {
  packages = [ pkgs.nodejs pkgs.electron ];
  ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
  ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron}/bin/";
}

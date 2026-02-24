/**
 * Silent install flags for Windows redistributables (VC++, DirectX, .NET, etc.)
 * Shared by UMU and legacy redistributable installers.
 */
export function getSilentInstallFlags(fileName: string, filePath?: string): string[] {
  const lowerFileName = fileName.toLowerCase();
  const lowerFilePath = (filePath ?? '').toLowerCase();

  if (lowerFileName.includes('vcredist') || lowerFileName.includes('vc_redist')) {
    return ['/S', '/v/qn'];
  }

  if (lowerFileName.includes('directx') || lowerFileName.includes('dxwebsetup')) {
    return ['/S'];
  }

  if (lowerFileName.includes('dotnet') || lowerFileName.includes('netfx')) {
    if (lowerFileName.includes('netfxrepairtool')) {
      return ['/p'];
    }
    return ['/S', '/v/qn'];
  }

  if (lowerFileName.endsWith('.msi')) {
    return ['/S', '/qn'];
  }

  if (lowerFilePath.includes('nsis') || lowerFileName.includes('setup')) {
    return ['/S'];
  }

  if (lowerFileName.includes('inno')) {
    return ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'];
  }

  if (lowerFileName.includes('installshield')) {
    return ['/S', '/v/qn'];
  }

  return ['/S'];
}

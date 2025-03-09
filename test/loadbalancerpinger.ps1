# Configuration
$url = "https://snippetbin.trickey.solutions/get"
$requestCount = 100  # Number of requests to make
$delayMs = 5      # Delay between requests in milliseconds

# Initialize tracking collections
$backendCounts = @{}
$backendLatencies = @{}
$backendSuccess = @{}
$totalSuccess = 0
$allLatencies = New-Object System.Collections.ArrayList

Write-Host "Starting load balancer distribution test..." -ForegroundColor Cyan
Write-Host "Making $requestCount requests to $url" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

# Loop to make multiple requests
for ($i = 0; $i -lt $requestCount; $i++) {
    try {
        # Start timing
        $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
        
        # Make the request
        $response = Invoke-WebRequest -Uri $url -Method GET -UseBasicParsing
        
        # Stop timing
        $stopwatch.Stop()
        $latency = $stopwatch.ElapsedMilliseconds
        
        # Get the backend server from the response header
        $backend = $response.Headers['X-Backend-Server']
        $region = $response.Headers['X-Backend-Region']
        
        # Track backend distribution
        if (-not $backendCounts.ContainsKey($backend)) {
            $backendCounts[$backend] = 0
            $backendLatencies[$backend] = New-Object System.Collections.ArrayList
            $backendSuccess[$backend] = 0
        }
        
        # Increment the counter for this backend
        $backendCounts[$backend]++
        
        # Add latency measurement to collections
        [void]$backendLatencies[$backend].Add($latency)
        [void]$allLatencies.Add($latency)
        
        # Track success status
        if ($response.StatusCode -eq 200) {
            $backendSuccess[$backend]++
            $totalSuccess++
            $healthStatus = "Success"
        } else {
            $healthStatus = "Failed"
        }
        
        # Format the output
        Write-Host ("[{0}/{1}] " -f ($i+1), $requestCount) -NoNewline
        Write-Host $backend -ForegroundColor Green -NoNewline
        Write-Host " ($region) " -ForegroundColor Yellow -NoNewline
        Write-Host "$latency ms " -ForegroundColor Magenta -NoNewline
        
        if ($response.StatusCode -eq 200) {
            Write-Host "[Success]" -ForegroundColor Green
        } else {
            Write-Host "[Failed - Status: $($response.StatusCode)]" -ForegroundColor Red
        }
        
        # Add delay between requests
        Start-Sleep -Milliseconds $delayMs
        
    } catch {
        Write-Host ("[{0}/{1}] Request failed: " -f ($i+1), $requestCount) -ForegroundColor Red -NoNewline
        Write-Host $_.Exception.Message
        
        # If we can extract backend information from the error, track it
        try {
            if ($_.Exception.Response -and $_.Exception.Response.Headers['X-Backend-Server']) {
                $failedBackend = $_.Exception.Response.Headers['X-Backend-Server']
                
                if (-not $backendCounts.ContainsKey($failedBackend)) {
                    $backendCounts[$failedBackend] = 0
                    $backendLatencies[$failedBackend] = New-Object System.Collections.ArrayList
                    $backendSuccess[$failedBackend] = 0
                }
                
                $backendCounts[$failedBackend]++
            }
        } catch {
            # If we can't extract backend info, count as general failure
        }
    }
}

# Calculate overall stats
$successRate = ($totalSuccess / $requestCount) * 100
$avgLatency = if ($allLatencies.Count -gt 0) { ($allLatencies | Measure-Object -Average).Average } else { 0 }

Write-Host "`n`nLoad Balancer Test Results:" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan

# Table header
$formatHeader = "{0,-55} | {1,5} | {2,8} | {3,7} |"
$formatRow = "{0,-55} | {1,4}% | {2,7}ms | {3,6}% |"
$separator = "-" * 85

Write-Host
Write-Host ($formatHeader -f "Backend", "Dist", "Latency", "Success")
Write-Host $separator

# Display each backend's stats
foreach ($key in $backendCounts.Keys | Sort-Object) {
    $percentage = ($backendCounts[$key] / $requestCount) * 100
    $backendAvg = if ($backendLatencies[$key].Count -gt 0) { ($backendLatencies[$key] | Measure-Object -Average).Average } else { 0 }
    $successPercentage = if ($backendCounts[$key] -gt 0) { ($backendSuccess[$key] / $backendCounts[$key]) * 100 } else { 0 }
    
    # Determine color based on success rate
    $successColor = if ($successPercentage -eq 100) { "Green" } else { "Red" }
    
    Write-Host -NoNewline ($formatRow -f $key, 
                                      [math]::Round($percentage), 
                                      [math]::Round($backendAvg, 1), 
                                      "")
    
    # Write success percentage with appropriate color
    Write-Host " $([math]::Round($successPercentage))%" -ForegroundColor $successColor
}

# Overall summary with colored success rate
Write-Host $separator
Write-Host -NoNewline ($formatRow -f "OVERALL", 
                                  100, 
                                  [math]::Round($avgLatency, 1),
                                  "")

# Write overall success percentage with appropriate color
$overallSuccessColor = if ($successRate -eq 100) { "Green" } else { "Red" }
Write-Host " $([math]::Round($successRate))%" -ForegroundColor $overallSuccessColor

# Add summary of total requests
Write-Host "`nTotal Requests: $requestCount"
Write-Host "Successful: $totalSuccess ($([Math]::Round($successRate, 1))%)" -ForegroundColor $overallSuccessColor
# Configuration
$url = "https://httpbin.trickey.solutions/get?snippet-test=true"
$requestCount = 50  # Number of requests to make
$delayMs = 100      # Delay between requests in milliseconds

# Initialize counters for each backend
$backendCounts = @{}

# Create table format for nice output
$format = @{
    Expression = { $_.Count + 1 }
    Label = "Request #"
    Width = 10
}

Write-Host "Starting load balancer distribution test..." -ForegroundColor Cyan
Write-Host "Making $requestCount requests to $url" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

# Loop to make multiple requests
for ($i = 0; $i -lt $requestCount; $i++) {
    try {
        # Make the request
        $response = Invoke-WebRequest -Uri $url -Method GET -UseBasicParsing
        
        # Get the backend server from the response header
        $backend = $response.Headers['X-Backend-Server']
        $region = $response.Headers['X-Backend-Region']
        
        # If backend doesn't exist in our counter hash, initialize it
        if (-not $backendCounts.ContainsKey($backend)) {
            $backendCounts[$backend] = 0
        }
        
        # Increment the counter for this backend
        $backendCounts[$backend]++
        
        # Format the output
        Write-Host ("[{0}/{1}] Request routed to: " -f ($i+1), $requestCount) -NoNewline
        Write-Host $backend -ForegroundColor Green -NoNewline
        Write-Host " ($region)" -ForegroundColor Yellow
        
        # Status code check
        if ($response.StatusCode -ne 200) {
            Write-Host "  ⚠️ Warning: Received status code $($response.StatusCode)" -ForegroundColor Red
        }
        
        # Add delay between requests
        Start-Sleep -Milliseconds $delayMs
        
    } catch {
        Write-Host ("[{0}/{1}] Request failed: " -f ($i+1), $requestCount) -ForegroundColor Red -NoNewline
        Write-Host $_.Exception.Message
    }
}

# Output summary
Write-Host "`nTest Complete - Distribution Summary:" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

foreach ($key in $backendCounts.Keys) {
    $percentage = ($backendCounts[$key] / $requestCount) * 100
    $barLength = [math]::Round($percentage / 5)
    $bar = "#" * $barLength
    
    Write-Host ("{0,-60}: {1,3}% ({2}/{3})" -f $key, [math]::Round($percentage), $backendCounts[$key], $requestCount) -NoNewline
    Write-Host " $bar" -ForegroundColor Green
}
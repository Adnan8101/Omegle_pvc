#!/bin/bash

# Remove comments from all TypeScript files
# Usage: ./remove-comments.sh

echo "🧹 Removing comments from TypeScript files..."

# Find all .ts files in src directory
find ./src -name "*.ts" | while read file; do
    echo "Processing: $file"
    
    # Use sed to remove comments:
    # 1. Remove single-line comments (// ...)
    # 2. Remove multi-line comments (/* ... */)
    # 3. Remove empty lines left behind
    
    # Create temp file
    temp_file=$(mktemp)
    
    # Remove multi-line comments first, then single-line
    perl -0777 -pe '
        # Remove multi-line comments (/* ... */)
        s|/\*.*?\*/||gs;
        # Remove single-line comments (// ...) but not URLs (http://, https://)
        s|(?<!:)//(?!/)[^\n]*||g;
        # Remove lines that are now empty or only whitespace
        s/^\s*\n//gm;
    ' "$file" > "$temp_file"
    
    # Replace original file
    mv "$temp_file" "$file"
done

echo "✅ Done! Comments removed from all TypeScript files."

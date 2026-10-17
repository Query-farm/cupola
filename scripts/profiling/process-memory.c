// macOS process accounting: includes native/WASM allocations and compressed
// memory, unlike a JavaScript heap snapshot. Sample one WebContent process.
#include <libproc.h>
#include <sys/resource.h>
#include <sys/time.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    pid_t pid = (pid_t)atoi(argv[1]);
    if (pid <= 0) return 2;
    setvbuf(stdout, NULL, _IOLBF, 0);
    for (;;) {
        struct rusage_info_v4 usage = {0};
        if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage)) return 1;
        struct timeval now;
        gettimeofday(&now, NULL);
        printf("{\"time\":%.0f,\"footprint\":%llu,\"resident\":%llu,\"lifetimePeak\":%llu}\n",
            now.tv_sec * 1000.0 + now.tv_usec / 1000.0,
            (unsigned long long)usage.ri_phys_footprint,
            (unsigned long long)usage.ri_resident_size,
            (unsigned long long)usage.ri_lifetime_max_phys_footprint);
        usleep(100000);
    }
}
